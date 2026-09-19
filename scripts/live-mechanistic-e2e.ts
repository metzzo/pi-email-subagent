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
let output = "", errors = ""; child.stdout.on("data", b => { output = (output + String(b)).slice(-256_000); }); child.stderr.on("data", b => { errors = (errors + String(b)).slice(-32_000); });
const prompt = `Use send_email to delegate exactly one request to an LLM worker. Ask it to invoke evidence.<task>@mechanistic.com with JSON message {"notify_to":"main@${model.split("/").at(-1)}.com"}, then independently inspect the resulting MECHANISTIC_EVIDENCE notification. The worker must send a new notification to main containing the exact nonce from evidence (not a static phrase). Do not use reply_to, requires_response, or completion fields. Wait for the worker notification and then finish.`;
child.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
// Let the real process settle and close its RPC stream normally; TERM/KILL are finite fallbacks only.
const orderly = setTimeout(() => child.stdin.end(), Math.max(30_000, timeout - 30_000));
const code = await new Promise<number|null>(resolveCode => { const timer=setTimeout(()=>{ child.kill("SIGTERM"); setTimeout(()=>child.kill("SIGKILL"), 5_000); }, timeout); child.once("close", c=>{clearTimeout(timer);clearTimeout(orderly);resolveCode(c)}); });
const files: string[] = [];
async function walk(d: string): Promise<void> { for (const e of await readdir(d, {withFileTypes:true})) { const p=join(d,e.name); if(e.isDirectory()) await walk(p); else if(e.name.endsWith(".jsonl")) files.push(p); } }
await walk(root);
let records: any[]=[]; for(const f of files) { try { records.push(...(await readFile(f,"utf8")).split("\n").filter(Boolean).map(x=>JSON.parse(x))); } catch {} }
const mails = records.filter(x=>x.type === "email.created").map(x=>x.email).filter(Boolean);
const jobs = records.filter(x=>x.type === "job.terminal").map(x=>x.job).filter(Boolean);
const trigger = mails.find(x=>x.to?.endsWith("@mechanistic.com"));
const evidence = mails.find(x=>x.subject === "MECHANISTIC_EVIDENCE");
const final = mails.find(x=>x.to?.startsWith("main@") && x.subject !== "MECHANISTIC_EVIDENCE");
const result = { model, childExitCode: code, root, mails: mails.length, jobs: jobs.map(x=>({id:x.id,result:x.result,phase:x.phase,outcomeMailId:x.outcomeMailId})), trigger: trigger && {id:trigger.id,from:trigger.from,to:trigger.to,kind:trigger.kind,requiresResponse:trigger.requiresResponse}, mechanisticEvidence: evidence && { id:evidence.id, from:evidence.from, to:evidence.to, kind:evidence.kind, requiresResponse:evidence.requiresResponse, inReplyTo:evidence.inReplyTo, message:evidence.message }, finalNotification: final && {id:final.id,from:final.from,to:final.to,kind:final.kind,requiresResponse:final.requiresResponse,inReplyTo:final.inReplyTo,message:final.message}, output, errors };
const log = join(logDir, `live-mechanistic-${Date.now()}.json`); await writeFile(log, JSON.stringify(result,null,2));
try { const evidenceBody=JSON.parse(String(evidence?.message)); if (!evidence || !final || !trigger || jobs.length !== 1 || jobs[0].id !== trigger.id || evidence.kind !== "notification" || final.kind !== "notification" || trigger.kind !== "notification" || evidence.requiresResponse || final.requiresResponse || trigger.requiresResponse || evidence.inReplyTo || final.inReplyTo || !evidenceBody.jobId || evidenceBody.jobId !== jobs[0].id || final.from === "main@gpt-5.6-luna.com" || final.from.endsWith("@mechanistic.com") || !String(final.message).includes(evidenceBody.nonce)) throw new Error("mechanistic chain assertions failed"); console.log(JSON.stringify({passed:true,model,log})); process.exitCode=0; } catch (e) { console.error(JSON.stringify({passed:false,model,log,error:String(e)})); process.exitCode=1; } finally { await rm(root,{recursive:true,force:true}); }
