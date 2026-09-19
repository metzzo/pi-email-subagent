#!/usr/bin/env tsx
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, copyFile, chmod, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const model = process.env.LIVE_MODEL;
if (!model) { console.error("Set LIVE_MODEL=provider/model (opt-in live run)."); process.exit(2); }
const timeout = Number(process.env.LIVE_TIMEOUT_MS ?? 240_000);
const root = await mkdtemp(join(tmpdir(), "pi-mechanistic-live-"));
const logDir = resolve(process.env.LIVE_EVIDENCE_DIR ?? ".test-workspaces/mechanistic-subagents");
await mkdir(logDir, { recursive: true });
const sourceAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? tmpdir(), ".pi", "agent");
await mkdir(root, { recursive: true, mode: 0o700 });
try { await access(join(sourceAgentDir, "auth.json")); await copyFile(join(sourceAgentDir, "auth.json"), join(root, "auth.json")); await chmod(join(root, "auth.json"), 0o600); } catch { /* provider may use another supported credential mechanism */ }
const script = join(root, "evidence.py");
await writeFile(join(root, "evidence.txt"), "NONCE-" + Math.random().toString(36).slice(2, 12));
await writeFile(script, `import json\nfrom pathlib import Path\nfrom pi_mechanistic import arguments, invocation, send_email, success\na=arguments(); nonce=Path('evidence.txt').read_text().strip()\nack=send_email(a['notify_to'], 'MECHANISTIC_EVIDENCE', json.dumps({'nonce':nonce,'jobId':invocation()['jobId']}))\nassert ack['accepted']\nsuccess('evidence processed: '+nonce)\n`);
await writeFile(join(root, "subagents.json"), JSON.stringify({ mechanisticPrograms: { evidence: { python: "python3", script, cwd: root, allowedCallers: ["llm"] } } }));
const child = spawn("pi", ["-ne", "-e", resolve("./src/index.ts"), "--mode", "rpc", "--no-session", "--model", model], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ["pipe", "pipe", "pipe"] });
let output = "", errors = "", settled = false; child.stdout.on("data", b => { const text=String(b); output = (output + text).slice(-8_000); if (text.includes('"type":"agent_settled"')) { settled=true; setTimeout(() => child.stdin.end(), 250); } }); child.stderr.on("data", b => { errors = (errors + String(b)).slice(-2_000); });
const worker = `evidence-worker.nonce@${model.split("/").at(-1)}.com`; const main = `main@${model.split("/").at(-1)}.com`;
const prompt = `Send exactly one new notification (requires_response:false) to ${worker}. In its message instruct that worker to invoke evidence.nonce@mechanistic.com exactly once with JSON {"notify_to":"${worker}"}, requires_response:false, then inspect the resulting MECHANISTIC_EVIDENCE notification and send a distinct new notification to ${main} containing the exact nonce and job ID. Do not use reply_to, completion fields, or response-required mail. Wait for the worker's final notification and finish.`;
child.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
// Let the real process settle and close its RPC stream normally; TERM/KILL are finite fallbacks only.
const orderly = setTimeout(() => child.stdin.end(), timeout - 30_000);
const code = await new Promise<number|null>(resolveCode => { const timer=setTimeout(()=>{ child.kill("SIGTERM"); setTimeout(()=>child.kill("SIGKILL"), 5_000); }, timeout); child.once("close", c=>{clearTimeout(timer);clearTimeout(orderly);resolveCode(c)}); });
const files: string[] = [];
async function walk(d: string): Promise<void> { for (const e of await readdir(d, {withFileTypes:true})) { const p=join(d,e.name); if(e.isDirectory()) await walk(p); else if(e.name.endsWith(".jsonl")) files.push(p); } }
await walk(root);
let records: any[]=[]; for(const f of files) { try { records.push(...(await readFile(f,"utf8")).split("\n").filter(Boolean).map(x=>JSON.parse(x))); } catch {} }
const mails = records.filter(x=>x.type === "email.created").map(x=>x.email).filter(Boolean);
const jobs = records.filter(x=>x.type === "job.terminal").map(x=>x.job).filter(Boolean);
const trigger = mails.find(x=>x.to === worker);
const invocation = mails.find(x=>x.to === "evidence.nonce@mechanistic.com");
const evidence = mails.find(x=>x.subject === "MECHANISTIC_EVIDENCE");
const final = mails.find(x=>x.to?.startsWith("main@") && x.subject !== "MECHANISTIC_EVIDENCE");
const result = { model, childExitCode: code, settled, mails: mails.length, jobs: jobs.map(x=>({id:x.id,result:x.result,phase:x.phase,outcomeMailId:x.outcomeMailId})), trigger: trigger && {id:trigger.id,from:trigger.from,to:trigger.to,kind:trigger.kind,requiresResponse:trigger.requiresResponse}, invocation: invocation && {id:invocation.id,from:invocation.from,to:invocation.to,kind:invocation.kind,requiresResponse:invocation.requiresResponse}, mechanisticEvidence: evidence && { id:evidence.id, from:evidence.from, to:evidence.to, kind:evidence.kind, requiresResponse:evidence.requiresResponse, inReplyTo:evidence.inReplyTo, message:evidence.message }, finalNotification: final && {id:final.id,from:final.from,to:final.to,kind:final.kind,requiresResponse:final.requiresResponse,inReplyTo:final.inReplyTo,message:final.message}, failure: errors ? errors.replace(/[^\\x20-\\x7e]/g, " ").slice(-500) : undefined };
const log = join(logDir, `live-mechanistic-${Date.now()}.json`); await writeFile(log, JSON.stringify(result,null,2));
try { const evidenceBody = evidence ? JSON.parse(String(evidence.message)) : undefined; if (!evidence || !final || !trigger || !invocation || !settled || jobs.length !== 1 || jobs[0].id !== trigger.id || invocation.kind !== "notification" || invocation.requiresResponse || invocation.inReplyTo || invocation.to !== "evidence.nonce@mechanistic.com" || evidence.kind !== "notification" || final.kind !== "notification" || trigger.kind !== "notification" || evidence.requiresResponse || final.requiresResponse || trigger.requiresResponse || evidence.inReplyTo || final.inReplyTo || !evidenceBody.jobId || evidenceBody.jobId !== jobs[0].id || final.from !== worker || final.to !== main || final.from.endsWith("@mechanistic.com") || !String(final.message).includes(evidenceBody.nonce)) throw new Error("mechanistic chain assertions failed"); console.log(JSON.stringify({passed:true,model,log})); process.exitCode=0; } catch (e) { console.error(JSON.stringify({passed:false,model,log,error:String(e)})); process.exitCode=1; } finally { await rm(root,{recursive:true,force:true}); }
