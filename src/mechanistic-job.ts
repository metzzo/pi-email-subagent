import { isAbsolute } from "node:path";
import { LIFECYCLE_FIELDS, MAX_TIMER_DELAY_MS } from "./config.ts";
import { ARTIFACT_BYTES, MAX_ARTIFACTS, PROTOCOL_BYTES, SUMMARY_BYTES, isMechanisticAddress, parseMechanisticBinding, parseMechanisticCallers } from "./mechanistic.ts";
import type { LifecyclePolicy, MechanisticCleanup, MechanisticJob, MechanisticProgress, MechanisticResult, MechanisticTerminal } from "./types.ts";

export function protocolObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
export function boundedProtocolString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum) throw new Error(`Expected a non-empty string of at most ${maximum} UTF-8 bytes.`);
  return value;
}
export function parseProgress(value: unknown): MechanisticProgress {
  const raw = protocolObject(value);
  const message = boundedProtocolString(raw.message, SUMMARY_BYTES);
  if (raw.percent !== undefined && (typeof raw.percent !== "number" || !Number.isFinite(raw.percent) || raw.percent < 0 || raw.percent > 100)) throw new Error("Progress percent must be 0–100.");
  return { message, ...(raw.percent === undefined ? {} : { percent: raw.percent as number }) };
}
export function parseTerminal(value: unknown): MechanisticTerminal {
  const raw = protocolObject(value);
  if (raw.status !== "success" && raw.status !== "failure") throw new Error("Invalid terminal status.");
  const summary = boundedProtocolString(raw.summary, SUMMARY_BYTES);
  const artifacts = raw.artifacts ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) throw new Error("Too many artifact references.");
  if (raw.invalidArguments !== undefined && (raw.invalidArguments !== true || raw.status !== "failure")) throw new Error("Invalid argument classification.");
  return { status: raw.status, summary, artifacts: artifacts.map((item) => boundedProtocolString(item, ARTIFACT_BYTES)), ...(raw.invalidArguments ? { invalidArguments: true } : {}) };
}
const RESULTS: MechanisticResult[] = ["success", "task_failure", "invalid_arguments", "spawn_failure", "crash", "timeout", "forced_stop", "protocol_failure", "missing_terminal", "interrupted"];
export function parseJob(value: unknown): MechanisticJob {
  const raw = protocolObject(value);
  const text = (key: string, maximum = 254) => boundedProtocolString(raw[key], maximum);
  const phase = raw.phase as MechanisticJob["phase"];
  if (!["queued", "starting", "running", "stopping", "terminal"].includes(phase)) throw new Error("Invalid job phase.");
  const address = text("address");
  const binding = parseMechanisticBinding(raw.binding);
  if (!isMechanisticAddress(address) || !address.startsWith(`${binding.key}.`)) throw new Error("Job binding/address mismatch.");
  const lifecycleRaw = protocolObject(raw.lifecycle);
  const lifecycle = {} as LifecyclePolicy;
  for (const key of LIFECYCLE_FIELDS) {
    const value = lifecycleRaw[key];
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_TIMER_DELAY_MS) throw new Error("Invalid job lifecycle.");
    lifecycle[key] = value as number;
  }
  const job: MechanisticJob = { id: text("id"), address, binding, allowedCallers: parseMechanisticCallers(raw.allowedCallers), lifecycle, phase, createdAt: text("createdAt"), updatedAt: text("updatedAt"), stderr: typeof raw.stderr === "string" && Buffer.byteLength(raw.stderr) <= PROTOCOL_BYTES ? raw.stderr : "" };
  if (typeof raw.stderr !== "string" || Buffer.byteLength(raw.stderr) > PROTOCOL_BYTES) throw new Error("Invalid stderr tail.");
  if (![job.createdAt, job.updatedAt].every((at) => Number.isFinite(Date.parse(at)))) throw new Error("Invalid job timestamp.");
  for (const key of ["generation", "pid"] as const) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 1) throw new Error(`Invalid job ${key}.`);
    job[key] = raw[key] as number;
  }
  if (raw.progress !== undefined) job.progress = parseProgress(raw.progress);
  if (raw.reported !== undefined) job.reported = parseTerminal(raw.reported);
  if (raw.result !== undefined) {
    if (!RESULTS.includes(raw.result as MechanisticResult)) throw new Error("Invalid runtime result.");
    job.result = raw.result as MechanisticResult;
  }
  if (raw.exitCode !== undefined) {
    if (raw.exitCode !== null && (!Number.isInteger(raw.exitCode) || (raw.exitCode as number) < 0)) throw new Error("Invalid exit code.");
    job.exitCode = raw.exitCode as number | null;
  }
  if (raw.signal !== undefined) job.signal = raw.signal === null ? null : text("signal", 32);
  if (raw.cleanup !== undefined) {
    const cleanup = protocolObject(raw.cleanup);
    if (!["confirmed", "cleanup-unknown"].includes(String(cleanup.state)) || cleanup.boundary !== "direct-child-only"
      || typeof cleanup.childExited !== "boolean" || typeof cleanup.pipesClosed !== "boolean"
      || (cleanup.state === "confirmed" && (!cleanup.childExited || !cleanup.pipesClosed))) throw new Error("Invalid direct-child cleanup evidence.");
    job.cleanup = { state: cleanup.state as MechanisticCleanup["state"], boundary: "direct-child-only", childExited: cleanup.childExited, pipesClosed: cleanup.pipesClosed, ...(cleanup.detail === undefined ? {} : { detail: boundedProtocolString(cleanup.detail, SUMMARY_BYTES) }) };
  }
  if (raw.outcomeMailId !== undefined) job.outcomeMailId = text("outcomeMailId");
  if (phase === "terminal" && (!job.result || !job.cleanup || !job.outcomeMailId)) throw new Error("Terminal job needs runtime result, cleanup evidence, and outcome ID.");
  if (phase !== "terminal" && (job.result || job.outcomeMailId)) throw new Error("Nonterminal job cannot have a runtime outcome.");
  if (phase === "queued" && (job.generation || job.pid)) throw new Error("Queued jobs cannot have process evidence.");
  if (phase !== "queued" && !job.generation) throw new Error("Claimed jobs need a generation.");
  return job;
}

export function outcomeText(job: MechanisticJob): string {
  return [
    `Job ${job.id} · ${job.address}`,
    `Runtime: ${job.result}. Script report: ${job.reported?.status ?? "none"}.`,
    job.reported?.summary,
    `Direct-child cleanup: ${job.cleanup?.state}; child exited: ${job.cleanup?.childExited}; pipes closed: ${job.cleanup?.pipesClosed}.`,
    `Exit: ${job.exitCode ?? "unknown"}; signal: ${job.signal ?? "none"}.`,
    "This notification is not a reply. It creates no response obligation. Detached descendants and remote effects are not covered by cleanup proof.",
    job.reported?.artifacts.length ? `Artifact references (not verified): ${JSON.stringify(job.reported.artifacts)}` : undefined,
  ].filter(Boolean).join("\n");
}
