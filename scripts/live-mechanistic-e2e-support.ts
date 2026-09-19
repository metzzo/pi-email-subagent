import { parseMailEvent, type MailEvent } from "../src/mail-store.ts";
import type { EmailEnvelope, MechanisticJob } from "../src/types.ts";

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

export function parseFiniteEnv(value: string | undefined, fallback: number, min = 30_000, max = 900_000): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`timeout must be an integer from ${min} to ${max}`);
  return number;
}
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
  if (!invocation) reasons.push("missing main-to-mechanistic invocation");
  if (!job || job.id !== invocation?.id) reasons.push("job is not linked to invocation");
  if (!final) reasons.push("missing worker final");
  if (!outcome || outcome.to !== input.main || outcome.from !== input.mechanistic) reasons.push("missing or mismatched automatic outcome");
  if (!final || final.subject !== "MECHANISTIC_CHAIN_COMPLETE") reasons.push("worker final subject mismatch");
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
