#!/usr/bin/env tsx
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const model = process.env.LIVE_MODEL;
if (!model) { console.error("Set LIVE_MODEL=provider/model (opt-in live run)."); process.exit(2); }
const timeout = Number(process.env.LIVE_TIMEOUT_MS ?? 240_000);
const root = await mkdtemp(join(tmpdir(), "pi-mechanistic-live-"));
const logDir = resolve(process.env.LIVE_EVIDENCE_DIR ?? ".test-workspaces/mechanistic-subagents");
await (await import("node:fs/promises")).mkdir(logDir, { recursive: true });
const script = join(root, "evidence.py");
await writeFile(join(root, "evidence.txt"), "NONCE-" + Math.random().toString(36).slice(2, 12));
await writeFile(script, `import json\nfrom pathlib import Path\nfrom pi_mechanistic import arguments, invocation, send_email, success\na=arguments(); nonce=Path('evidence.txt').read_text().strip()\nack=send_email(a['notify_to'], 'MECHANISTIC_EVIDENCE', json.dumps({'nonce':nonce,'jobId':invocation()['jobId']}))\nassert ack['accepted']\nsuccess('evidence processed: '+nonce)\n`);
await writeFile(join(root, "subagents.json"), JSON.stringify({ mechanisticPrograms: { evidence: { python: "python3", script, cwd: root, allowedCallers: ["llm"] } } }));
const child = spawn("pi", ["-ne", "-e", resolve("./src/index.ts"), "--mode", "rpc", "--no-session", "--model", model], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ["pipe", "pipe", "pipe"] });
let output = "", errors = ""; child.stdout.on("data", b => output += String(b)); child.stderr.on("data", b => errors += String(b));
const prompt = `Use send_email to delegate exactly one request to an LLM worker. Ask it to invoke evidence.<task>@mechanistic.com with JSON message {"notify_to":"main@${model.split("/").at(-1)}.com"}, then independently inspect the resulting MECHANISTIC_EVIDENCE notification. The worker must send a new notification to main containing the exact nonce from evidence (not a static phrase). Do not use reply_to, requires_response, or completion fields. Wait for the worker notification and then finish.`;
child.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
const code = await new Promise<number|null>(resolveCode => { const timer=setTimeout(()=>child.kill("SIGTERM"), timeout); child.once("close", c=>{clearTimeout(timer);resolveCode(c)}); });
const files: string[] = [];
async function walk(d: string): Promise<void> { for (const e of await readdir(d, {withFileTypes:true})) { const p=join(d,e.name); if(e.isDirectory()) await walk(p); else if(e.name.endsWith(".jsonl")) files.push(p); } }
await walk(root);
let records: any[]=[]; for(const f of files) { try { records.push(...(await readFile(f,"utf8")).split("\n").filter(Boolean).map(x=>JSON.parse(x))); } catch {} }
const mails = records.filter(x=>x.type === "email.created").map(x=>x.email).filter(Boolean);
const evidence = mails.find(x=>x.subject === "MECHANISTIC_EVIDENCE");
const final = mails.find(x=>x.to?.startsWith("main@") && x.subject !== "MECHANISTIC_EVIDENCE");
const result = { model, childExitCode: code, root, mails: mails.length, mechanisticEvidence: evidence && { id:evidence.id, from:evidence.from, to:evidence.to, kind:evidence.kind, requiresResponse:evidence.requiresResponse }, finalNotification: final && {id:final.id,from:final.from,to:final.to,kind:final.kind,requiresResponse:final.requiresResponse,message:final.message}, output, errors };
const log = join(logDir, `live-mechanistic-${Date.now()}.json`); await writeFile(log, JSON.stringify(result,null,2));
try { if (!evidence || !final || evidence.kind !== "notification" || final.kind !== "notification" || evidence.requiresResponse || final.requiresResponse || !String(final.message).includes(JSON.parse(String(evidence.message)).nonce)) throw new Error("mechanistic chain assertions failed"); console.log(JSON.stringify({passed:true,model,log})); process.exitCode=0; } catch (e) { console.error(JSON.stringify({passed:false,model,log,error:String(e)})); process.exitCode=1; } finally { await rm(root,{recursive:true,force:true}); }
