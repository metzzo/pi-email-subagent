import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_LIFECYCLE, LIFECYCLE_FIELDS, MAX_TIMER_DELAY_MS } from "./config.ts";
import type { ActivityItem, AgentRecord, AgentStatus, AgentWorkState, BrokerRegistry, LifecyclePolicy, UsageSnapshot, WorkItem } from "./types.ts";
import { capPatch, capText, emptyWorkState, MAX_ACTIVE_WORK, MAX_COMMAND_CHARS, MAX_ERROR_CHARS, MAX_RECENT_WORK, sanitizeWorkPath } from "./work-ledger.ts";
import { clone, nowIso } from "./util.ts";

const EFFORTS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const STATES = new Set<AgentStatus>(["queued", "spawning", "running", "idle", "failed", "stopped", "paused", "archived"]);
const ACTIVITY_KINDS = new Set<ActivityItem["kind"]>(["status", "tool", "text", "error"]);
const WORK_KINDS = new Set<WorkItem["kind"]>(["edit", "write", "shell", "custom"]);
const WORK_STATUSES = new Set<WorkItem["status"]>(["running", "succeeded", "failed", "interrupted"]);
const WORK_ATTRIBUTIONS = new Set<WorkItem["attribution"]>(["explicit", "unverified"]);

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
  return value.map((item, index) => {
    const raw = object(item, `${label}[${index}]`);
    const kind = string(raw.kind, `${label}[${index}].kind`) as ActivityItem["kind"];
    if (!ACTIVITY_KINDS.has(kind)) throw new Error(`${label}[${index}].kind is invalid.`);
    return {
      at: string(raw.at, `${label}[${index}].at`),
      kind,
      summary: /^(?:edit|write)\s+\{/i.test(string(raw.summary, `${label}[${index}].summary`))
        ? `${String(raw.summary).split(/\s/, 1)[0]} (legacy mutation arguments hidden)`
        : string(raw.summary, `${label}[${index}].summary`),
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
  if ((kind === "edit" || kind === "write") !== (attribution === "explicit")) throw new Error(`${label} has incoherent attribution.`);
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
  for (const key of ["path", "displayPath"] as const) {
    const parsed = optionalString(raw[key], `${label}.${key}`); if (parsed !== undefined) item[key] = sanitizeWorkPath(parsed);
  }
  const command = capText(raw.commandPreview, MAX_COMMAND_CHARS); if (command) item.commandPreview = command;
  const error = capText(raw.error, MAX_ERROR_CHARS); if (error) item.error = error;
  if (typeof raw.patchPreview === "string" && Buffer.byteLength(raw.patchPreview, "utf8") > 1024 * 1024) throw new Error(`${label}.patchPreview exceeds parsing bound.`);
  const patch = capPatch(raw.patchPreview); if (patch.patchPreview) item.patchPreview = patch.patchPreview;
  if (raw.patchTruncated === true || patch.patchTruncated) item.patchTruncated = true;
  if (raw.patchSource === "event" || raw.patchSource === "session") item.patchSource = raw.patchSource;
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
  for (const key of ["currentBatchId"] as const) { const parsed = optionalCount(raw[key], `${label}.${key}`); if (parsed !== undefined) work[key] = parsed; }
  for (const key of ["batchStartedAt", "batchEndedAt"] as const) { if (raw[key] !== undefined) work[key] = timestamp(raw[key], `${label}.${key}`); }
  const recoveryError = capText(raw.recoveryError, MAX_ERROR_CHARS); if (recoveryError) work.recoveryError = recoveryError;
  return work;
}

function parseRecord(value: unknown, index: number): AgentRecord {
  const label = `registry.agents[${index}]`;
  const raw = object(value, label);
  const effort = string(raw.effort, `${label}.effort`) as ThinkingLevel;
  const state = string(raw.state, `${label}.state`) as AgentStatus;
  if (!EFFORTS.has(effort)) throw new Error(`${label}.effort is invalid.`);
  if (!STATES.has(state)) throw new Error(`${label}.state is invalid.`);
  if (!Number.isInteger(raw.enforcementAttempts) || (raw.enforcementAttempts as number) < 0) {
    throw new Error(`${label}.enforcementAttempts must be a non-negative integer.`);
  }
  if (raw.canSpawn !== undefined && typeof raw.canSpawn !== "boolean") {
    throw new Error(`${label}.canSpawn must be a boolean.`);
  }
  const record: AgentRecord = {
    address: string(raw.address, `${label}.address`).toLowerCase(),
    name: string(raw.name, `${label}.name`),
    taskSlug: string(raw.taskSlug, `${label}.taskSlug`),
    provider: string(raw.provider, `${label}.provider`),
    modelId: string(raw.modelId, `${label}.modelId`),
    effort,
    tools: stringArray(raw.tools, `${label}.tools`),
    // Absent in registries written before spawn control existed.
    canSpawn: raw.canSpawn === undefined ? true : (raw.canSpawn as boolean),
    state,
    createdAt: string(raw.createdAt, `${label}.createdAt`),
    updatedAt: string(raw.updatedAt, `${label}.updatedAt`),
    enforcementAttempts: raw.enforcementAttempts as number,
    // Registries from before lifecycle watchdogs receive the finite shipped defaults.
    lifecycle: parseLifecycle(raw.lifecycle, `${label}.lifecycle`),
    usage: parseUsage(raw.usage, `${label}.usage`),
    activity: parseActivity(raw.activity, `${label}.activity`),
    work: parseWork(raw.work, `${label}.work`),
  };
  for (const [key, fieldLabel] of [
    ["instructions", `${label}.instructions`],
    ["sessionFile", `${label}.sessionFile`],
    ["lastActivityAt", `${label}.lastActivityAt`],
    ["currentActivity", `${label}.currentActivity`],
    ["failure", `${label}.failure`],
  ] as const) {
    let parsed = optionalString(raw[key], fieldLabel);
    if (key === "currentActivity" && parsed && /^(?:edit|write)\s+\{/i.test(parsed)) parsed = `${parsed.split(/\s/, 1)[0]} (legacy mutation arguments hidden)`;
    if (parsed !== undefined) (record as unknown as Record<string, unknown>)[key] = parsed;
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
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.path);
      try { await chmod(this.path, 0o600); } catch { /* unsupported platform */ }
    });
    this.writeChain = operation;
    await operation;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}
