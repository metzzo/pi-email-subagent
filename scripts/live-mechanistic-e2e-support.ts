import { StringDecoder } from "node:string_decoder";
import { parseMailEvent, type MailEvent } from "../src/mail-store.ts";
import type { EmailEnvelope, MechanisticJob } from "../src/types.ts";

export class BoundedJsonlDecoder { private decoder=new StringDecoder("utf8"); private buffer=""; constructor(private readonly maxBytes=8*1024*1024) {} push(chunk:Buffer|string): unknown[]{ this.buffer+=this.decoder.write(typeof chunk==='string'?Buffer.from(chunk):chunk); if(Buffer.byteLength(this.buffer)>this.maxBytes)throw new Error("RPC record oversized"); const out:unknown[]=[]; let n=this.buffer.indexOf("\n"); while(n>=0){const line=this.buffer.slice(0,n);this.buffer=this.buffer.slice(n+1);if(line.trim()){const value=JSON.parse(line);if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("RPC record must be object");out.push(value);}n=this.buffer.indexOf("\n");}return out;} end():void{this.buffer+=this.decoder.end();if(this.buffer.trim())throw new Error("unterminated RPC record");} }
export interface LiveGraphInput {
  events: MailEvent[];
  worker: string;
  main: string;
  mechanistic: string;
  childExitCode?: number | null;
  timedOut?: boolean;
  durableFinalObserved?: boolean;
  mainSettled?: boolean;
  pollError?: string;
}
export interface LiveValidation { ok: boolean; reasons: string[]; envelopes: number; jobId?: string; outcomeId?: string; }

export async function waitForLiveGraph(agentDir:string, sessionId:unknown, worker:string, main:string, ready:()=>boolean, signal:AbortSignal, strictAfterClose=false):Promise<{events:MailEvent[];envelopes:EmailEnvelope[]}> { const path=childJournalPath(agentDir,sessionId); while(!signal.aborted){ try { const text=await (await import('node:fs/promises')).readFile(path,'utf8'); let events:MailEvent[]; try { events=parseLfJournal(text); } catch(error) { if(!strictAfterClose && /truncated/.test(String(error))) { await new Promise<void>((resolve,reject)=>{const t=setTimeout(resolve,250);signal.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('poll aborted'));},{once:true});}); continue; } throw new Error('stable malformed journal'); } const envelopes=collectEnvelopes(events); if(hasDurableFinal(envelopes,worker,main)&&ready()) return {events,envelopes}; } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT'&&!strictAfterClose) { await new Promise<void>((resolve,reject)=>{const t=setTimeout(resolve,250);signal.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('poll aborted'));},{once:true});}); continue; } throw error; } } throw new Error('poll aborted'); }
export interface SafeRpcState { sessionId?:string; getStateCount:number; promptSuccess:boolean; settled:boolean; protocolError?:string; }
export function reduceSafeRpc(state:SafeRpcState, event:unknown):void { if(!event||typeof event!=="object"||Array.isArray(event))throw new Error("RPC event must be object"); const e=event as Record<string,unknown>; if(e.type==='response'&&e.command==='get_state'&&e.success===true){state.getStateCount++;if(state.getStateCount!==1)throw new Error("duplicate get_state");const data=e.data as Record<string,unknown>;state.sessionId=safeSessionId(data?.sessionId);} else if(e.type==='response'&&e.command==='prompt'){state.promptSuccess=e.success===true;} else if(e.type==='agent_settled')state.settled=true; else if(e.type==='extension_error')state.protocolError='extension error'; }
export function parseFiniteEnv(value: string | undefined, fallback: number, min = 30_000, max = 900_000): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`timeout must be an integer from ${min} to ${max}`);
  return number;
}
export function safeSessionId(value: unknown): string { if(typeof value!=="string"||!/^[A-Za-z0-9-]{1,128}$/.test(value)) throw new Error("unsafe or missing session ID"); return value; }
export function childJournalPath(agentDir: string, sessionId: unknown): string { return `${agentDir}/subagents/${safeSessionId(sessionId)}/mail.jsonl`; }
export function parseLiveModel(value: string | undefined): { provider: string; modelId: string } {
  if (!value) throw new Error("LIVE_MODEL is required");
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw new Error("LIVE_MODEL must use provider/model");
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}
export function parseLfJournal(text: string): MailEvent[] {
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new Error("truncated journal record");
  return text.split("\n").filter(Boolean).map((line) => parseMailEvent(JSON.parse(line)));
}
export function collectEnvelopes(events: MailEvent[]): EmailEnvelope[] {
  const unique = new Map<string, EmailEnvelope>();
  for (const event of events) if ("email" in event && event.email) unique.set(event.email.id, event.email);
  return [...unique.values()];
}
export function hasDurableFinal(envelopes: EmailEnvelope[], worker: string, main: string): boolean {
  return envelopes.some((email) => email.from === worker && email.to === main && email.subject === "MECHANISTIC_CHAIN_COMPLETE" && email.kind === "notification" && !email.requiresResponse && email.inReplyTo === undefined);
}
export function validateLiveGraph(input: LiveGraphInput): LiveValidation {
  const reasons: string[] = [];
  const envelopes = collectEnvelopes(input.events);
  const invocation = envelopes.find((email) => email.from === input.main && email.to === input.mechanistic);
  const final = envelopes.find((email) => email.from === input.worker && email.to === input.main);
  const terminals = input.events.filter((event) => event.type === "job.terminal") as Array<{ job: MechanisticJob }>;
  const job: MechanisticJob | undefined = terminals[0]?.job;
  const outcome = job ? envelopes.find((email) => email.id === job.outcomeMailId) : undefined;
  if (envelopes.length !== 4) reasons.push("expected exactly four unique envelopes");
  if (!invocation) reasons.push("missing main-to-mechanistic invocation"); else if (invocation.kind !== "notification") reasons.push("invocation must be notification");
  const evidence = envelopes.find((email) => email.from === input.mechanistic && email.to === input.worker && email.subject === "MECHANISTIC_EVIDENCE");
  if (!evidence) reasons.push("missing mechanistic evidence"); else { if(evidence.from!==input.mechanistic) reasons.push("evidence sender mismatch"); if(evidence.to!==input.worker) reasons.push("evidence recipient mismatch"); if(evidence.subject!=="MECHANISTIC_EVIDENCE") reasons.push("evidence subject mismatch"); }
  if (evidence) { const structured=evidence.message.match(/Structured: (\{.*\})$/)?.[1]; let parsed:{nonce?:string;jobId?:string}|undefined; try { parsed=structured?JSON.parse(structured):undefined; } catch {} if(!parsed?.nonce||!parsed?.jobId||parsed.jobId!==invocation?.id) reasons.push("evidence nonce/job linkage mismatch"); }
  if (!job || job.id !== invocation?.id) reasons.push("job is not linked to invocation");
  if (!final) reasons.push("missing worker final");
  if (!outcome || outcome.to !== input.main || outcome.from !== input.mechanistic) reasons.push("missing or mismatched automatic outcome"); else if(!job || outcome.subject!==`Job ${job.id}: success`) reasons.push("outcome subject mismatch");
  if (!final || final.subject !== "MECHANISTIC_CHAIN_COMPLETE") reasons.push("worker final subject mismatch"); else if(final.to!==input.main) reasons.push("worker final recipient mismatch");
  if (final && job && !final.message.includes(job.id)) reasons.push("final job-ID linkage mismatch");
  if (evidence && final) { const structured=evidence.message.match(/Structured: (\{.*\})$/)?.[1]; let ep:{nonce?:string;jobId?:string}|undefined; try { ep=structured?JSON.parse(structured):undefined; } catch {} const finalJson=final.message.match(/(\{.*\})$/)?.[1]; let fp:{nonce?:string;jobId?:string}|undefined; try { fp=finalJson?JSON.parse(finalJson):undefined; } catch {} if(!ep?.nonce||!fp?.nonce||ep.nonce!==fp.nonce||fp.jobId!==job?.id) reasons.push("final nonce/job linkage mismatch"); }
  if (evidence && job && !evidence.message.includes(job.id)) reasons.push("evidence job-ID linkage mismatch");
  for (const email of envelopes) {
    if (email.kind !== "notification") reasons.push("graph contains a reply");
    if (email.requiresResponse !== false) reasons.push("graph contains response-required mail");
    if (email.inReplyTo !== undefined) reasons.push("graph contains correlated mail");
    if (email.completion !== undefined) reasons.push("graph contains completion metadata");
  }
  if (job?.result !== "success" || job.exitCode !== 0 || (job.signal !== undefined && job.signal !== null)) reasons.push("runtime did not succeed cleanly");
  if (job?.cleanup?.state !== "confirmed") reasons.push("direct-child cleanup is not confirmed");
  if (input.childExitCode !== undefined && input.childExitCode !== 0) reasons.push("Pi child exit was nonzero");
  if (input.timedOut) reasons.push("runner timed out");
  if (input.durableFinalObserved === false) reasons.push("final was not durably observed before shutdown");
  if (input.mainSettled === false) reasons.push("main did not settle");
  if (input.pollError) reasons.push("journal polling failed");
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)].slice(0, 32), envelopes: envelopes.length, jobId: job?.id, outcomeId: job?.outcomeMailId };
}
