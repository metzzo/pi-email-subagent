#!/usr/bin/env tsx
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { BoundedJsonlDecoder, reduceSafeRpc, childJournalPath, parseFiniteEnv, parseLiveModel, parseLfJournal, hasDurableFinal, validateLiveGraph } from "./live-mechanistic-e2e-support.ts";

const model = process.env.LIVE_MODEL;
let timeout:number;
try { parseLiveModel(model); timeout=parseFiniteEnv(process.env.LIVE_TIMEOUT_MS,240_000); } catch(error) { console.error(error instanceof Error?error.message:String(error)); process.exit(2); }
const liveModel = model!;
const root = await mkdtemp(join(tmpdir(), "pi-mechanistic-live-"));
const logDir = resolve(process.env.LIVE_EVIDENCE_DIR ?? ".test-workspaces/mechanistic-subagents");
await mkdir(logDir, { recursive: true });
await mkdir(root, { recursive: true, mode: 0o700 });
const script = join(root, "evidence.py");
await writeFile(join(root, "evidence.txt"), "NONCE-" + Math.random().toString(36).slice(2, 12));
await writeFile(script, `import json\nfrom pathlib import Path\nfrom pi_mechanistic import arguments, invocation, send_email, success, failure\na=arguments(); nonce=Path('evidence.txt').read_text().strip(); job=invocation()['jobId']\nack=send_email(a['notify_to'], 'MECHANISTIC_EVIDENCE', 'Send MECHANISTIC_CHAIN_COMPLETE to main with nonce '+nonce+' and job ID '+job+'. Structured: '+json.dumps({'nonce':nonce,'jobId':job}))\nif not ack.get('accepted'):\n    failure('broker rejected mechanistic notification: '+json.dumps(ack, sort_keys=True))\n    import sys; sys.exit(0)\nsuccess('evidence processed: '+nonce)\n`);
await writeFile(join(root, "subagents.json"), JSON.stringify({ mechanisticPrograms: { evidence: { python: "python3", script, cwd: root, allowedCallers: ["main"] } } }));
const rpcState={getStateCount:0,promptSuccess:false,settled:false} as {getStateCount:number;promptSuccess:boolean;settled:boolean;sessionId?:string}; const decoder=new BoundedJsonlDecoder(); let decoderError="";
const child = spawn("pi", ["-ne", "-e", resolve("./src/index.ts"), "--mode", "rpc", "--no-session", "--model", liveModel], { cwd: root, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
let errors = ""; child.stdout.on("data", b => { try { for(const event of decoder.push(b)) reduceSafeRpc(rpcState,event); } catch(error) { decoderError=error instanceof Error?error.message:"RPC decoder error"; child.kill("SIGTERM"); } }); child.stderr.resume();
const worker = `evidence-worker.nonce@${liveModel.split("/").at(-1)}.com`; const main = `main@${liveModel.split("/").at(-1)}.com`;
const prompt = `Use send_email exactly once to invoke evidence.nonce@mechanistic.com directly. Send notification requires_response:false with JSON {"notify_to":"${worker}"}; no reply_to or completion. Then wait for the real Luna worker to receive evidence and send MECHANISTIC_CHAIN_COMPLETE to ${main}.`;
child.stdin.write(JSON.stringify({ type: "get_state" }) + "\n"); child.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
// Let the real process settle and close its RPC stream normally; TERM/KILL are finite fallbacks only.
const orderly = setTimeout(() => child.stdin.end(), timeout - 30_000);
let completionObserved = false;
const poll = setInterval(async () => { try { const stack=[root]; while(stack.length){ const d=stack.pop()!; for(const e of await readdir(d,{withFileTypes:true})){ const p=join(d,e.name); if(e.isDirectory()) stack.push(p); else if(e.name === 'mail.jsonl') { const text=await readFile(p,'utf8'); for(const line of text.split('\n')) { try { const ev=JSON.parse(line); const em=ev.email; if(em && em.from===worker && em.to===main && em.kind==='notification' && em.requiresResponse===false && em.inReplyTo===undefined) completionObserved=true; } catch {} } } } } if(completionObserved) child.stdin.end(); } catch {} }, 2_000);
const code = await new Promise<number|null>(resolveCode => { const timer=setTimeout(()=>{ child.kill("SIGTERM"); setTimeout(()=>child.kill("SIGKILL"), 5_000); }, timeout); child.once("close", c=>{clearTimeout(timer);clearTimeout(orderly);clearInterval(poll);resolveCode(c)}); });
try { decoder.end(); } catch(error) { decoderError=error instanceof Error?error.message:"RPC decoder error"; }
const settled=rpcState.settled; const sessionId=rpcState.sessionId; const agentDir=process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? tmpdir(), ".pi", "agent"); const exactJournal=sessionId?childJournalPath(agentDir,sessionId):undefined;
const files: string[] = [];
async function walk(d: string): Promise<void> { for (const e of await readdir(d, {withFileTypes:true})) { const p=join(d,e.name); if(e.isDirectory()) await walk(p); else if(e.name === "mail.jsonl") files.push(p); } }
if(exactJournal) files.push(exactJournal);
let records: any[]=[]; let parseError=""; for(const f of files) { try { records.push(...parseLfJournal(await readFile(f,"utf8"))); } catch(error) { parseError=error instanceof Error?error.message:"journal parse failed"; } }
const mails = [...new Map(records.flatMap(x=>x.email ? [x.email] : []).map(x=>[x.id,x])).values()];
const jobs = records.filter(x=>x.type === "job.terminal").map(x=>x.job).filter(Boolean);
const trigger = mails.find(x=>x.to === worker);
const invocation = mails.find(x=>x.to === "evidence.nonce@mechanistic.com");
const evidence = mails.find(x=>x.subject === "MECHANISTIC_EVIDENCE");
const final = mails.find(x=>x.from === worker && x.to === main);
const diagnostics:string[]=[]; async function collectDiagnostics(d:string):Promise<void>{ for(const e of await readdir(d,{withFileTypes:true})){ const p=join(d,e.name); if(e.isDirectory()) await collectDiagnostics(p); else if(e.name==='registry.json'||e.name.endsWith('.jsonl')) diagnostics.push(p); } } await collectDiagnostics(root);
const envelopeSummary = mails.map(x=>({id:x.id,from:x.from,to:x.to,subject:x.subject,kind:x.kind,requiresResponse:x.requiresResponse,inReplyTo:x.inReplyTo,deliveryState:x.deliveryState,completion:Boolean(x.completion)}));
const registryFiles=diagnostics.filter(f=>f.endsWith('registry.json')); const sessionFiles=diagnostics.filter(f=>f.endsWith('.jsonl')&&!f.endsWith('mail.jsonl')); const diagnosticSummary={registryFiles:registryFiles.map(f=>f.split('/').pop()),sessionFiles:sessionFiles.map(f=>f.split('/').pop()),runEndedAt:new Date().toISOString(),diagnosticFileCount:diagnostics.length};

const result = { model, childExitCode: code, settled, completionObserved, mails: mails.length, envelopes: envelopeSummary, diagnostics:diagnosticSummary, jobs: jobs.map(x=>({id:x.id,result:x.result,phase:x.phase,outcomeMailId:x.outcomeMailId,exitCode:x.exitCode,signal:x.signal,stderr:typeof x.stderr === "string" ? x.stderr.slice(-1000).replace(/[^\x20-\x7e]/g," ") : undefined,reported:x.reported,cleanup:x.cleanup})), trigger: trigger && {id:trigger.id,from:trigger.from,to:trigger.to,kind:trigger.kind,requiresResponse:trigger.requiresResponse}, invocation: invocation && {id:invocation.id,from:invocation.from,to:invocation.to,kind:invocation.kind,requiresResponse:invocation.requiresResponse}, mechanisticEvidence: evidence && { id:evidence.id, from:evidence.from, to:evidence.to, kind:evidence.kind, requiresResponse:evidence.requiresResponse, inReplyTo:evidence.inReplyTo, message:evidence.message }, finalNotification: final && {id:final.id,from:final.from,to:final.to,kind:final.kind,requiresResponse:final.requiresResponse,inReplyTo:final.inReplyTo,message:final.message}, failure: errors ? errors.replace(/[^\x20-\x7e]/g, " ").slice(-500) : undefined };
const log = join(logDir, `live-mechanistic-${Date.now()}.json`); await writeFile(log, JSON.stringify(result,null,2));
try { const shared=validateLiveGraph({events:records,worker,main,mechanistic: "evidence.nonce@mechanistic.com",childExitCode:code,timedOut:false,durableFinalObserved:completionObserved,mainSettled:settled,pollError:parseError||undefined}); if(!shared.ok) throw new Error(shared.reasons.join("; ")); if(!hasDurableFinal((result as any).envelopes,worker,main)) throw new Error("durable final predicate failed"); const evidenceText = String(evidence?.message ?? ""); const nonce = evidenceText.match(/nonce\s+(NONCE-[A-Za-z0-9]+)/)?.[1]; const evidenceJobId = evidenceText.match(/job ID\s+(mail_[A-Za-z0-9_]+)/)?.[1]; const evidenceBody = nonce && evidenceJobId ? { nonce, jobId: evidenceJobId } : undefined; if (!evidence || !final || !trigger || !invocation || !completionObserved || jobs.length !== 1 || jobs[0].id !== invocation.id || invocation.kind !== "notification" || invocation.requiresResponse || invocation.inReplyTo || invocation.to !== "evidence.nonce@mechanistic.com" || evidence.kind !== "notification" || final.kind !== "notification" || trigger.kind !== "notification" || evidence.requiresResponse || final.requiresResponse || trigger.requiresResponse || evidence.inReplyTo || final.inReplyTo || !evidenceBody || !evidenceBody.jobId || evidenceBody.jobId !== jobs[0].id || final.from !== worker || final.to !== main || final.from.endsWith("@mechanistic.com") || !String(final.message).includes(evidenceBody!.nonce)) throw new Error("mechanistic chain assertions failed"); console.log(JSON.stringify({passed:true,model,log})); process.exitCode=0; } catch (e) { console.error(JSON.stringify({passed:false,model,log,error:String(e)})); process.exitCode=1; } finally { await rm(root,{recursive:true,force:true}); }
