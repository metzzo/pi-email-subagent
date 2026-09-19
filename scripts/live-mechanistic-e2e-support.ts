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
  mainQuiescent?: boolean;
  pollError?: string;
}
export interface RpcQuiescence {
  agentStarts: number;
  agentEnds: number;
  settled: number;
  followOnEnds: number;
  retryingEnd: boolean;
  quiescent: boolean;
}
export function summarizeRpcQuiescence(
  events: ReadonlyArray<{ type?: string; willRetry?: unknown }>,
): RpcQuiescence {
  const agentStarts = events.filter(
    (event) => event.type === "agent_start",
  ).length;
  const agentEnds = events.filter((event) => event.type === "agent_end").length;
  const settled = events.filter(
    (event) => event.type === "agent_settled",
  ).length;
  const retryingEnd = events.some(
    (event) => event.type === "agent_end" && event.willRetry === true,
  );
  const followOnEnds = Math.max(0, agentEnds - 1);
  const quiescent =
    agentStarts >= 2 &&
    agentStarts === agentEnds &&
    settled >= 1 &&
    followOnEnds >= 1 &&
    !retryingEnd;
  return {
    agentStarts,
    agentEnds,
    settled,
    followOnEnds,
    retryingEnd,
    quiescent,
  };
}
export interface LiveValidation {
  ok: boolean;
  reasons: string[];
  envelopes: number;
  jobId?: string;
  outcomeId?: string;
}

export function parseFiniteEnv(
  value: string | undefined,
  fallback: number,
  min = 30_000,
  max = 900_000,
): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`timeout must be an integer from ${min} to ${max}`);
  return number;
}
export function safeSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(value))
    throw new Error("unsafe or missing session ID");
  return value;
}
export function childJournalPath(agentDir: string, sessionId: unknown): string {
  return `${agentDir}/subagents/${safeSessionId(sessionId)}/mail.jsonl`;
}
export function parseLiveModel(value: string | undefined): {
  provider: string;
  modelId: string;
} {
  if (!value) throw new Error("LIVE_MODEL is required");
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1)
    throw new Error("LIVE_MODEL must use provider/model");
  return {
    provider: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}
export function parseLfJournal(text: string): MailEvent[] {
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new Error("truncated journal record");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => parseMailEvent(JSON.parse(line)));
}
export function collectEnvelopes(events: MailEvent[]): EmailEnvelope[] {
  const unique = new Map<string, EmailEnvelope>();
  for (const event of events) {
    if ("email" in event && event.email)
      unique.set(event.email.id, { ...event.email });
    if (event.type === "email.delivered") {
      const email = unique.get(event.id);
      if (email)
        unique.set(event.id, {
          ...email,
          deliveryState: "delivered",
          deliveredAt: event.at,
        });
    }
    if (event.type === "email.failed") {
      const email = unique.get(event.id);
      if (email)
        unique.set(event.id, {
          ...email,
          deliveryState: "failed",
        });
    }
    if (event.type === "email.cancelled") {
      const email = unique.get(event.id);
      if (email) unique.set(event.id, { ...email, deliveryState: "cancelled" });
    }
  }
  return [...unique.values()];
}
export function hasDurableFinal(
  envelopes: EmailEnvelope[],
  worker: string,
  main: string,
): boolean {
  return envelopes.some(
    (email) =>
      email.from === worker &&
      email.to === main &&
      email.subject === "MECHANISTIC_CHAIN_COMPLETE" &&
      email.kind === "notification" &&
      !email.requiresResponse &&
      email.inReplyTo === undefined,
  );
}
export function validateLiveGraph(input: LiveGraphInput): LiveValidation {
  const reasons: string[] = [];
  const envelopes = collectEnvelopes(input.events);
  const invocation = envelopes.find(
    (email) => email.from === input.main && email.to === input.mechanistic,
  );
  const final = envelopes.find(
    (email) => email.from === input.worker && email.to === input.main,
  );
  const terminals = input.events.filter(
    (event) => event.type === "job.terminal",
  ) as Array<{ job: MechanisticJob }>;
  const job: MechanisticJob | undefined = terminals[0]?.job;
  const outcome = job
    ? envelopes.find((email) => email.id === job.outcomeMailId)
    : undefined;
  if (envelopes.length !== 4)
    reasons.push("expected exactly four unique envelopes");
  if (!invocation) reasons.push("missing main-to-mechanistic invocation");
  else if (invocation.kind !== "notification")
    reasons.push("invocation must be notification");
  const evidence = envelopes.find(
    (email) =>
      email.from === input.mechanistic &&
      email.to === input.worker &&
      email.subject === "MECHANISTIC_EVIDENCE",
  );
  if (!evidence) reasons.push("missing mechanistic evidence");
  else {
    if (evidence.from !== input.mechanistic)
      reasons.push("evidence sender mismatch");
    if (evidence.to !== input.worker)
      reasons.push("evidence recipient mismatch");
    if (evidence.subject !== "MECHANISTIC_EVIDENCE")
      reasons.push("evidence subject mismatch");
  }
  if (evidence) {
    const structured = evidence.message.match(/Structured: (\{.*\})$/)?.[1];
    let parsed: { nonce?: string; jobId?: string } | undefined;
    try {
      parsed = structured ? JSON.parse(structured) : undefined;
    } catch {}
    if (!parsed?.nonce || !parsed?.jobId || parsed.jobId !== invocation?.id)
      reasons.push("evidence nonce/job linkage mismatch");
  }
  if (!job || job.id !== invocation?.id)
    reasons.push("job is not linked to invocation");
  if (!final) reasons.push("missing worker final");
  if (
    !outcome ||
    outcome.to !== input.main ||
    outcome.from !== input.mechanistic
  )
    reasons.push("missing or mismatched automatic outcome");
  else if (!job || outcome.subject !== `Job ${job.id}: success`)
    reasons.push("outcome subject mismatch");
  else if (outcome.deliveryState !== "delivered")
    reasons.push("automatic outcome was not delivered");
  if (!final || final.subject !== "MECHANISTIC_CHAIN_COMPLETE")
    reasons.push("worker final subject mismatch");
  else if (final.to !== input.main)
    reasons.push("worker final recipient mismatch");
  else if (final.deliveryState !== "delivered")
    reasons.push("worker final was not delivered");
  if (final && job && !final.message.includes(job.id))
    reasons.push("final job-ID linkage mismatch");
  if (evidence && final) {
    const structured = evidence.message.match(/Structured: (\{.*\})$/)?.[1];
    let ep: { nonce?: string; jobId?: string } | undefined;
    try {
      ep = structured ? JSON.parse(structured) : undefined;
    } catch {}
    const finalJson = final.message.match(/(\{.*\})$/)?.[1];
    let fp: { nonce?: string; jobId?: string } | undefined;
    try {
      fp = finalJson ? JSON.parse(finalJson) : undefined;
    } catch {}
    if (
      !ep?.nonce ||
      !fp?.nonce ||
      ep.nonce !== fp.nonce ||
      fp.jobId !== job?.id
    )
      reasons.push("final nonce/job linkage mismatch");
  }
  if (evidence && job && !evidence.message.includes(job.id))
    reasons.push("evidence job-ID linkage mismatch");
  for (const email of envelopes) {
    if (email.kind !== "notification") reasons.push("graph contains a reply");
    if (email.requiresResponse !== false)
      reasons.push("graph contains response-required mail");
    if (email.inReplyTo !== undefined)
      reasons.push("graph contains correlated mail");
    if (email.completion !== undefined)
      reasons.push("graph contains completion metadata");
  }
  if (
    job?.result !== "success" ||
    job.exitCode !== 0 ||
    (job.signal !== undefined && job.signal !== null)
  )
    reasons.push("runtime did not succeed cleanly");
  if (job?.cleanup?.state !== "confirmed")
    reasons.push("direct-child cleanup is not confirmed");
  if (input.childExitCode !== undefined && input.childExitCode !== 0)
    reasons.push("Pi child exit was nonzero");
  if (input.timedOut) reasons.push("runner timed out");
  if (input.durableFinalObserved === false)
    reasons.push("final was not durably observed before shutdown");
  if (input.mainQuiescent !== true) reasons.push("main was not quiescent");
  if (input.pollError) reasons.push("journal polling failed");
  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)].slice(0, 32),
    envelopes: envelopes.length,
    jobId: job?.id,
    outcomeId: job?.outcomeMailId,
  };
}
