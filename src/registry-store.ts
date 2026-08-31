import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_LIFECYCLE,
  EFFORT_LEVELS,
  isSafeConfigSemanticText,
  LIFECYCLE_FIELDS,
  MAX_CONFIG_INSTRUCTIONS_BYTES,
  MAX_CONFIG_PROFILE_TOOLS,
  MAX_CONFIG_TOOL_NAME_BYTES,
  MAX_TIMER_DELAY_MS,
} from "./config.ts";
import type { ActivityItem, AgentRecord, AgentStatus, AgentWorkState, BrokerRegistry, CleanupDiagnostic, LifecyclePolicy, UsageSnapshot, WorkItem, WorkerCapabilityEpoch } from "./types.ts";
import { capPatch, capText, emptyWorkState, MAX_ACTIVE_WORK, MAX_COMMAND_CHARS, MAX_ERROR_CHARS, MAX_RECENT_WORK, sanitizeWorkPath } from "./work-ledger.ts";
import { clone, nowIso } from "./util.ts";

const EFFORTS = new Set<ThinkingLevel>(EFFORT_LEVELS);
const STATES = new Set<AgentStatus>(["queued", "spawning", "running", "idle", "failed", "stopped", "paused", "archived"]);
const ACTIVITY_KINDS = new Set<ActivityItem["kind"]>(["status", "tool", "text", "error"]);
const WORK_KINDS = new Set<WorkItem["kind"]>(["edit", "write", "shell", "custom"]);
const WORK_STATUSES = new Set<WorkItem["status"]>(["running", "succeeded", "failed", "interrupted", "unknown"]);
const WORK_ATTRIBUTIONS = new Set<WorkItem["attribution"]>(["explicit", "unverified"]);
const WORK_OBSERVED_RESULTS = new Set<NonNullable<WorkItem["observedResult"]>>(["success", "error"]);
const WORK_UNKNOWN_REASONS = new Set<NonNullable<WorkItem["reasonCode"]>>(["missing-start", "mismatched-tool", "unsafe-path", "orphan-result"]);
const CLEANUP_STATES = new Set<CleanupDiagnostic["state"]>(["pending", "unknown"]);
const CLEANUP_PHASES = new Set<CleanupDiagnostic["abort"]>(["pending", "succeeded", "failed", "timed-out"]);
const MAX_CLEANUP_DETAIL_CHARS = 2_000;
const MAX_CLEANUP_TOOLS = 64;
const WORKER_EPOCH_PHASES = new Set<WorkerCapabilityEpoch["phase"]>(["spawning", "activated", "session-settled"]);
const LEGACY_WORKER_EPOCH_PHASES = new Set(["verified-clean", "operator-released"] as const);
const MAX_WORKER_EPOCH_TOOLS = 128;
const MAX_LEGACY_CLEANUP_EVIDENCE_BYTES = 1_024;
export const MAX_REGISTRY_ACTIVITY_ITEMS = 40;
export const MAX_REGISTRY_ACTIVITY_SUMMARY_BYTES = 2_000;
export const MAX_REGISTRY_DIAGNOSTIC_BYTES = 2_048;
const MAX_REGISTRY_SESSION_FILE_BYTES = 4_096;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return string(value, label);
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number.`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${label} must be an array of strings.`);
  return [...value];
}

function boundedString(value: unknown, label: string, maximumBytes: number): string {
  const parsed = string(value, label);
  if (Buffer.byteLength(parsed, "utf8") > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} UTF-8 bytes.`);
  return parsed;
}

function parseProfileTools(value: unknown, label: string): string[] {
  const tools = stringArray(value, label);
  if (tools.length > MAX_CONFIG_PROFILE_TOOLS || new Set(tools).size !== tools.length) {
    throw new Error(`${label} must contain at most ${MAX_CONFIG_PROFILE_TOOLS} unique names.`);
  }
  if (tools.some((tool) => !tool || Buffer.byteLength(tool, "utf8") > MAX_CONFIG_TOOL_NAME_BYTES)) {
    throw new Error(`${label} names must be non-empty and at most ${MAX_CONFIG_TOOL_NAME_BYTES} UTF-8 bytes.`);
  }
  if (tools.some((tool) => !isSafeConfigSemanticText(tool, false))) {
    throw new Error(`${label} names must not contain control or bidirectional-control characters.`);
  }
  return tools;
}

function parseLifecycle(value: unknown, label: string): LifecyclePolicy {
  if (value === undefined) return { ...DEFAULT_LIFECYCLE };
  const raw = object(value, label);
  const lifecycle = {} as LifecyclePolicy;
  for (const key of LIFECYCLE_FIELDS) {
    const candidate = raw[key];
    if (!Number.isInteger(candidate) || (candidate as number) < 1 || (candidate as number) > MAX_TIMER_DELAY_MS) {
      throw new Error(`${label}.${key} must be an integer from 1 to ${MAX_TIMER_DELAY_MS} (the runtime-safe timer maximum).`);
    }
    lifecycle[key] = candidate as number;
  }
  return lifecycle;
}

function parseUsage(value: unknown, label: string): UsageSnapshot {
  const raw = object(value, label);
  return {
    input: number(raw.input, `${label}.input`),
    output: number(raw.output, `${label}.output`),
    cacheRead: number(raw.cacheRead, `${label}.cacheRead`),
    cacheWrite: number(raw.cacheWrite, `${label}.cacheWrite`),
    cost: number(raw.cost, `${label}.cost`),
    contextTokens: number(raw.contextTokens, `${label}.contextTokens`),
    turns: number(raw.turns, `${label}.turns`),
  };
}

function parseActivity(value: unknown, label: string): ActivityItem[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > MAX_REGISTRY_ACTIVITY_ITEMS) throw new Error(`${label} must contain at most ${MAX_REGISTRY_ACTIVITY_ITEMS} items.`);
  return value.map((item, index) => {
    const raw = object(item, `${label}[${index}]`);
    const kind = string(raw.kind, `${label}[${index}].kind`) as ActivityItem["kind"];
    if (!ACTIVITY_KINDS.has(kind)) throw new Error(`${label}[${index}].kind is invalid.`);
    const summary = boundedString(raw.summary, `${label}[${index}].summary`, MAX_REGISTRY_ACTIVITY_SUMMARY_BYTES);
    return {
      at: string(raw.at, `${label}[${index}].at`),
      kind,
      summary: /^(?:edit|write)\s+\{/i.test(summary)
        ? `${summary.split(/\s/, 1)[0]} (legacy mutation arguments hidden)`
        : summary,
    };
  });
}

function timestamp(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${label} must be a valid timestamp.`);
  return parsed;
}

function optionalCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000_000) throw new Error(`${label} must be a bounded non-negative safe integer.`);
  return value as number;
}

function parseWorkItem(value: unknown, label: string): WorkItem {
  const raw = object(value, label);
  const kind = string(raw.kind, `${label}.kind`) as WorkItem["kind"];
  const status = string(raw.status, `${label}.status`) as WorkItem["status"];
  const attribution = string(raw.attribution, `${label}.attribution`) as WorkItem["attribution"];
  if (!WORK_KINDS.has(kind) || !WORK_STATUSES.has(status) || !WORK_ATTRIBUTIONS.has(attribution)) throw new Error(`${label} has an invalid work enum.`);
  if (attribution === "explicit" && kind !== "edit" && kind !== "write") throw new Error(`${label} has incoherent attribution.`);
  if ((kind === "edit" || kind === "write") && raw.toolName !== kind) throw new Error(`${label} has incoherent mutation tool name.`);
  if (kind === "shell" && raw.toolName !== "bash") throw new Error(`${label} has incoherent shell tool name.`);
  const batchId = optionalCount(raw.batchId, `${label}.batchId`);
  if (batchId === undefined) throw new Error(`${label}.batchId is required.`);
  const rawId = string(raw.toolCallId, `${label}.toolCallId`); const rawName = string(raw.toolName, `${label}.toolName`);
  if (rawId.length > 200 || rawName.length > 100) throw new Error(`${label} identifiers exceed bounds.`);
  const item: WorkItem = {
    toolCallId: capText(rawId, 200)!,
    batchId,
    toolName: capText(rawName, 100)!, kind, status, attribution,
    startedAt: timestamp(raw.startedAt, `${label}.startedAt`),
  };
  for (const key of ["durationMs", "editBlocks", "bytesWritten", "linesWritten", "linesAdded", "linesRemoved", "firstChangedLine"] as const) {
    const parsed = optionalCount(raw[key], `${label}.${key}`); if (parsed !== undefined) item[key] = parsed;
  }
  const endedAt = raw.endedAt === undefined ? undefined : timestamp(raw.endedAt, `${label}.endedAt`); if (endedAt) item.endedAt = endedAt;
  if (raw.observedResult !== undefined) {
    if (!WORK_OBSERVED_RESULTS.has(raw.observedResult as NonNullable<WorkItem["observedResult"]>)) throw new Error(`${label}.observedResult is invalid.`);
    item.observedResult = raw.observedResult as NonNullable<WorkItem["observedResult"]>;
  }
  if (raw.reasonCode !== undefined) {
    if (!WORK_UNKNOWN_REASONS.has(raw.reasonCode as NonNullable<WorkItem["reasonCode"]>)) throw new Error(`${label}.reasonCode is invalid.`);
    item.reasonCode = raw.reasonCode as NonNullable<WorkItem["reasonCode"]>;
  }
  for (const key of ["path", "displayPath"] as const) {
    const parsed = optionalString(raw[key], `${label}.${key}`); if (parsed !== undefined) item[key] = sanitizeWorkPath(parsed);
  }
  const command = capText(raw.commandPreview, MAX_COMMAND_CHARS); if (command) item.commandPreview = command;
  const error = capText(raw.error, MAX_ERROR_CHARS); if (error) item.error = error;
  if (typeof raw.patchPreview === "string" && Buffer.byteLength(raw.patchPreview, "utf8") > 1024 * 1024) throw new Error(`${label}.patchPreview exceeds parsing bound.`);
  const patch = capPatch(raw.patchPreview); if (patch.patchPreview) item.patchPreview = patch.patchPreview;
  if (raw.patchTruncated === true || patch.patchTruncated) item.patchTruncated = true;
  if (raw.patchSource === "event" || raw.patchSource === "session") item.patchSource = raw.patchSource;
  if (status === "unknown") {
    if (attribution !== "unverified" || !item.observedResult || !item.reasonCode || item.path
      || item.patchPreview || item.bytesWritten !== undefined || item.linesWritten !== undefined
      || item.linesAdded !== undefined || item.linesRemoved !== undefined) {
      throw new Error(`${label} unknown effect evidence must be unverified, structural, and path-free.`);
    }
  } else if (item.reasonCode !== undefined) throw new Error(`${label}.reasonCode is valid only for unknown work.`);
  return item;
}

function parseWork(value: unknown, label: string): AgentWorkState {
  if (value === undefined) return emptyWorkState();
  const raw = object(value, label);
  const nextBatchId = optionalCount(raw.nextBatchId, `${label}.nextBatchId`);
  if (!nextBatchId || !Array.isArray(raw.active) || !Array.isArray(raw.recent)) throw new Error(`${label} is malformed.`);
  if (raw.active.length > MAX_ACTIVE_WORK) throw new Error(`${label}.active exceeds the ${MAX_ACTIVE_WORK}-item safety bound; running intent is never silently evicted.`);
  const active = raw.active.map((item, index) => parseWorkItem(item, `${label}.active[${index}]`));
  const recent = raw.recent.slice(-MAX_RECENT_WORK).map((item, index) => parseWorkItem(item, `${label}.recent[${index}]`));
  if (active.some((item) => item.status !== "running" || item.endedAt)) throw new Error(`${label}.active must contain running items only.`);
  if (recent.some((item) => item.status === "running" || !item.endedAt)) throw new Error(`${label}.recent must contain ended terminal items only.`);
  if ([...active, ...recent].some((item) => item.attribution === "explicit" && !item.path)) throw new Error(`${label} explicit work requires a path.`);
  const seen = new Set<string>();
  for (const item of [...active, ...recent]) {
    if (seen.has(item.toolCallId)) throw new Error(`${label} contains duplicate toolCallId ${item.toolCallId}.`);
    seen.add(item.toolCallId);
  }
  const counters = object(raw.inspection, `${label}.inspection`);
  const work: AgentWorkState = {
    nextBatchId,
    active,
    recent,
    inspection: {
      reads: optionalCount(counters.reads, `${label}.inspection.reads`) ?? 0,
      searches: optionalCount(counters.searches, `${label}.inspection.searches`) ?? 0,
      listings: optionalCount(counters.listings, `${label}.inspection.listings`) ?? 0,
    },
  };
  if (raw.effectEvidenceUnavailable !== undefined && typeof raw.effectEvidenceUnavailable !== "boolean") {
    throw new Error(`${label}.effectEvidenceUnavailable must be a boolean.`);
  }
  if (raw.effectEvidenceUnavailable === true) work.effectEvidenceUnavailable = true;
  for (const key of ["currentBatchId"] as const) { const parsed = optionalCount(raw[key], `${label}.${key}`); if (parsed !== undefined) work[key] = parsed; }
  for (const key of ["batchStartedAt", "batchEndedAt"] as const) { if (raw[key] !== undefined) work[key] = timestamp(raw[key], `${label}.${key}`); }
  const recoveryError = capText(raw.recoveryError, MAX_ERROR_CHARS); if (recoveryError) work.recoveryError = recoveryError;
  return work;
}

function parseWorkerEpoch(value: unknown, label: string): {
  epoch: WorkerCapabilityEpoch;
  legacyPhase?: "verified-clean" | "operator-released";
} | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, label);
  if (!Number.isSafeInteger(raw.generation) || (raw.generation as number) < 1) {
    throw new Error(`${label}.generation must be a positive safe integer.`);
  }
  const rawPhase = string(raw.phase, `${label}.phase`);
  const currentPhase = WORKER_EPOCH_PHASES.has(rawPhase as WorkerCapabilityEpoch["phase"])
    ? rawPhase as WorkerCapabilityEpoch["phase"]
    : undefined;
  const legacyPhase = LEGACY_WORKER_EPOCH_PHASES.has(rawPhase as "verified-clean" | "operator-released")
    ? rawPhase as "verified-clean" | "operator-released"
    : undefined;
  if (!currentPhase && !legacyPhase) throw new Error(`${label}.phase is invalid.`);
  const tools = stringArray(raw.tools, `${label}.tools`);
  if (tools.length > MAX_WORKER_EPOCH_TOOLS || new Set(tools).size !== tools.length
    || tools.some((tool) => !tool
      || Buffer.byteLength(tool, "utf8") > MAX_CONFIG_TOOL_NAME_BYTES
      || !isSafeConfigSemanticText(tool, false))) {
    throw new Error(`${label}.tools must contain at most ${MAX_WORKER_EPOCH_TOOLS} unique safe names of at most ${MAX_CONFIG_TOOL_NAME_BYTES} UTF-8 bytes.`);
  }
  if (typeof raw.mutationCapable !== "boolean") throw new Error(`${label}.mutationCapable must be a boolean.`);
  if (typeof raw.runSlotHeld !== "boolean") throw new Error(`${label}.runSlotHeld must be a boolean.`);
  if ((currentPhase === "session-settled" || legacyPhase) && raw.runSlotHeld) {
    throw new Error(`${label}.runSlotHeld must be false for a settled or legacy released phase.`);
  }
  return {
    epoch: {
      generation: raw.generation as number,
      phase: currentPhase ?? "session-settled",
      tools,
      mutationCapable: raw.mutationCapable,
      runSlotHeld: raw.runSlotHeld,
    },
    ...(legacyPhase ? { legacyPhase } : {}),
  };
}

interface LegacyCleanupAudit {
  workerGeneration: number;
}

function parseLegacyCleanupAudit(value: unknown, label: string): LegacyCleanupAudit | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, label);
  if (!Number.isSafeInteger(raw.workerGeneration) || (raw.workerGeneration as number) < 1) {
    throw new Error(`${label}.workerGeneration must be a positive safe integer.`);
  }
  if (raw.source !== "operator-attested") throw new Error(`${label}.source must be operator-attested.`);
  const evidence = boundedString(raw.evidence, `${label}.evidence`, MAX_LEGACY_CLEANUP_EVIDENCE_BYTES);
  if (evidence.trim().length < 8) throw new Error(`${label}.evidence must contain at least 8 characters.`);
  timestamp(raw.releasedAt, `${label}.releasedAt`);
  return { workerGeneration: raw.workerGeneration as number };
}

function parseCleanup(value: unknown, label: string, fallbackTools: readonly string[]): CleanupDiagnostic | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, label);
  const state = string(raw.state, `${label}.state`) as CleanupDiagnostic["state"];
  const abort = string(raw.abort, `${label}.abort`) as CleanupDiagnostic["abort"];
  const dispose = string(raw.dispose, `${label}.dispose`) as CleanupDiagnostic["dispose"];
  if (!CLEANUP_STATES.has(state)) throw new Error(`${label}.state is invalid.`);
  if (!CLEANUP_PHASES.has(abort) || !CLEANUP_PHASES.has(dispose)) throw new Error(`${label} has an invalid cleanup phase.`);
  if (raw.quiescence !== "unknown") throw new Error(`${label}.quiescence must be unknown while persisted.`);
  if (raw.mutationCapableAtStart !== undefined && typeof raw.mutationCapableAtStart !== "boolean") {
    throw new Error(`${label}.mutationCapableAtStart must be a boolean.`);
  }
  if (raw.heldRunSlot !== undefined && typeof raw.heldRunSlot !== "boolean") {
    throw new Error(`${label}.heldRunSlot must be a boolean.`);
  }
  if (raw.heldRunSlot === undefined && raw.heldCapacity !== true) {
    throw new Error(`${label}.heldRunSlot must be a boolean (legacy heldCapacity must be true).`);
  }
  const mutationCapableAtStart = raw.mutationCapableAtStart === undefined
    ? fallbackTools.some((tool) => tool === "bash" || tool === "edit" || tool === "write")
    : raw.mutationCapableAtStart;
  const heldRunSlot = raw.heldRunSlot === undefined ? true : raw.heldRunSlot;
  if (!Number.isSafeInteger(raw.workerGeneration) || (raw.workerGeneration as number) < 1) {
    throw new Error(`${label}.workerGeneration must be a positive safe integer.`);
  }
  const reasonCode = string(raw.reasonCode, `${label}.reasonCode`);
  if (reasonCode.length > 100) throw new Error(`${label}.reasonCode exceeds 100 characters.`);
  if (!Array.isArray(raw.activeTools) || raw.activeTools.length > MAX_CLEANUP_TOOLS) {
    throw new Error(`${label}.activeTools must be an array of at most ${MAX_CLEANUP_TOOLS} items.`);
  }
  const activeTools = raw.activeTools.map((item, index) => {
    const tool = object(item, `${label}.activeTools[${index}]`);
    const toolCallId = string(tool.toolCallId, `${label}.activeTools[${index}].toolCallId`);
    const toolName = string(tool.toolName, `${label}.activeTools[${index}].toolName`);
    if (toolCallId.length > 200 || toolName.length > 100) throw new Error(`${label}.activeTools identifiers exceed bounds.`);
    return { toolCallId, toolName };
  });
  const detail = optionalString(raw.detail, `${label}.detail`);
  if (detail && detail.length > MAX_CLEANUP_DETAIL_CHARS) throw new Error(`${label}.detail exceeds ${MAX_CLEANUP_DETAIL_CHARS} characters.`);
  return {
    state,
    reasonCode,
    workerGeneration: raw.workerGeneration as number,
    startedAt: timestamp(raw.startedAt, `${label}.startedAt`),
    updatedAt: timestamp(raw.updatedAt, `${label}.updatedAt`),
    abort,
    dispose,
    quiescence: "unknown",
    mutationCapableAtStart,
    heldRunSlot,
    activeTools,
    ...(detail ? { detail } : {}),
  };
}

function parseRecord(value: unknown, index: number): AgentRecord {
  const label = `registry.agents[${index}]`;
  const raw = object(value, label);
  const effort = string(raw.effort, `${label}.effort`) as ThinkingLevel;
  const rawState = string(raw.state, `${label}.state`);
  if (rawState === "parked") {
    throw new Error(`${label}.state uses the unsupported pre-0.1 nested-delegation journal state "parked"; remove or migrate this development namespace.`);
  }
  const state = rawState as AgentStatus;
  if (!EFFORTS.has(effort)) throw new Error(`${label}.effort is invalid.`);
  if (!STATES.has(state)) throw new Error(`${label}.state is invalid.`);
  if (!Number.isInteger(raw.enforcementAttempts) || (raw.enforcementAttempts as number) < 0) {
    throw new Error(`${label}.enforcementAttempts must be a non-negative integer.`);
  }
  if (raw.consecutiveFailures !== undefined
    && (!Number.isInteger(raw.consecutiveFailures) || (raw.consecutiveFailures as number) < 0)) {
    throw new Error(`${label}.consecutiveFailures must be a non-negative integer.`);
  }
  const record: AgentRecord = {
    address: string(raw.address, `${label}.address`).toLowerCase(),
    name: string(raw.name, `${label}.name`),
    taskSlug: string(raw.taskSlug, `${label}.taskSlug`),
    provider: string(raw.provider, `${label}.provider`),
    modelId: string(raw.modelId, `${label}.modelId`),
    effort,
    tools: parseProfileTools(raw.tools, `${label}.tools`),
    state,
    createdAt: string(raw.createdAt, `${label}.createdAt`),
    updatedAt: string(raw.updatedAt, `${label}.updatedAt`),
    ...(raw.consecutiveFailures === undefined ? {} : { consecutiveFailures: raw.consecutiveFailures as number }),
    enforcementAttempts: raw.enforcementAttempts as number,
    // Registries from before lifecycle watchdogs receive the finite shipped defaults.
    lifecycle: parseLifecycle(raw.lifecycle, `${label}.lifecycle`),
    usage: parseUsage(raw.usage, `${label}.usage`),
    activity: parseActivity(raw.activity, `${label}.activity`),
    work: parseWork(raw.work, `${label}.work`),
  };
  const parsedWorkerEpoch = parseWorkerEpoch(raw.workerEpoch, `${label}.workerEpoch`);
  if (parsedWorkerEpoch) record.workerEpoch = parsedWorkerEpoch.epoch;
  const cleanup = parseCleanup(raw.cleanup, `${label}.cleanup`, record.workerEpoch?.tools ?? record.tools);
  if (cleanup) record.cleanup = cleanup;
  const legacyCleanupAudit = parseLegacyCleanupAudit(raw.lastCleanupRecovery, `${label}.lastCleanupRecovery`);
  if (parsedWorkerEpoch?.legacyPhase === "operator-released"
    && (!legacyCleanupAudit
      || legacyCleanupAudit.workerGeneration !== parsedWorkerEpoch.epoch.generation
      || parsedWorkerEpoch.epoch.runSlotHeld
      || cleanup)) {
    throw new Error(`${label}.workerEpoch legacy operator-released phase requires its exact durable audit, no run-slot hold, and no cleanup diagnostic.`);
  }
  const instructions = raw.instructions === undefined
    ? undefined
    : boundedString(raw.instructions, `${label}.instructions`, MAX_CONFIG_INSTRUCTIONS_BYTES);
  if (instructions !== undefined) {
    if (!isSafeConfigSemanticText(instructions, true)) throw new Error(`${label}.instructions contains control or bidirectional-control characters.`);
    record.instructions = instructions;
  }
  const sessionFile = raw.sessionFile === undefined
    ? undefined
    : boundedString(raw.sessionFile, `${label}.sessionFile`, MAX_REGISTRY_SESSION_FILE_BYTES);
  if (sessionFile !== undefined) record.sessionFile = sessionFile;
  const lastActivityAt = optionalString(raw.lastActivityAt, `${label}.lastActivityAt`);
  if (lastActivityAt !== undefined) record.lastActivityAt = lastActivityAt;
  for (const key of ["currentActivity", "failure"] as const) {
    let parsed = raw[key] === undefined
      ? undefined
      : boundedString(raw[key], `${label}.${key}`, MAX_REGISTRY_DIAGNOSTIC_BYTES);
    if (key === "currentActivity" && parsed && /^(?:edit|write)\s+\{/i.test(parsed)) parsed = `${parsed.split(/\s/, 1)[0]} (legacy mutation arguments hidden)`;
    if (parsed !== undefined) record[key] = parsed;
  }
  if (parsedWorkerEpoch?.legacyPhase === "operator-released") {
    const warning = "Legacy operator cleanup release was canonicalized as inactive history; it is not Pi session settlement or OS-process proof. Explicit same-identity restart is required.";
    record.state = "failed";
    record.failure = warning;
    record.currentActivity = warning;
    record.activity.push({ at: nowIso(), kind: "status", summary: warning });
    record.activity = record.activity.slice(-MAX_REGISTRY_ACTIVITY_ITEMS);
    record.updatedAt = nowIso();
  }
  return record;
}

export function parseRegistry(value: unknown): BrokerRegistry {
  const raw = object(value, "registry");
  if (raw.version !== 1) throw new Error("registry.version must be 1.");
  const aliases = stringArray(raw.mainAliases, "registry.mainAliases").map((alias) => alias.toLowerCase());
  if (!Array.isArray(raw.agents)) throw new Error("registry.agents must be an array.");
  const agents = raw.agents.map(parseRecord);
  const addresses = new Set<string>();
  for (const record of agents) {
    if (addresses.has(record.address)) throw new Error(`registry contains duplicate agent ${record.address}.`);
    addresses.add(record.address);
  }
  return {
    version: 1,
    mainAddress: string(raw.mainAddress, "registry.mainAddress").toLowerCase(),
    mainAliases: [...new Set(aliases)],
    agents,
    updatedAt: string(raw.updatedAt, "registry.updatedAt"),
  };
}

export class RegistryStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async load(defaultMainAddress: string): Promise<BrokerRegistry> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try { await chmod(dirname(this.path), 0o700); } catch { /* unsupported platform */ }
    if (!existsSync(this.path)) {
      return { version: 1, mainAddress: defaultMainAddress, mainAliases: [defaultMainAddress], agents: [], updatedAt: nowIso() };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
      return clone(parseRegistry(parsed));
    } catch (error) {
      throw new Error(`Unsupported or corrupt subagent registry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async save(registry: BrokerRegistry): Promise<void> {
    const snapshot = clone({ ...parseRegistry(registry), updatedAt: nowIso() });
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temp, this.path);
        try { await chmod(this.path, 0o600); } catch { /* unsupported platform */ }
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    });
    this.writeChain = operation;
    await operation;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}
