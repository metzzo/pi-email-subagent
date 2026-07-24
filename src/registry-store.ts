import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ActivityItem, AgentRecord, AgentStatus, BrokerRegistry, UsageSnapshot } from "./types.ts";
import { clone, nowIso } from "./util.ts";

const EFFORTS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const STATES = new Set<AgentStatus>(["queued", "spawning", "running", "idle", "failed", "stopped", "paused", "archived"]);
const ACTIVITY_KINDS = new Set<ActivityItem["kind"]>(["status", "tool", "text", "error"]);

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
      summary: string(raw.summary, `${label}[${index}].summary`),
    };
  });
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
  const record: AgentRecord = {
    address: string(raw.address, `${label}.address`).toLowerCase(),
    name: string(raw.name, `${label}.name`),
    taskSlug: string(raw.taskSlug, `${label}.taskSlug`),
    provider: string(raw.provider, `${label}.provider`),
    modelId: string(raw.modelId, `${label}.modelId`),
    effort,
    tools: stringArray(raw.tools, `${label}.tools`),
    state,
    createdAt: string(raw.createdAt, `${label}.createdAt`),
    updatedAt: string(raw.updatedAt, `${label}.updatedAt`),
    enforcementAttempts: raw.enforcementAttempts as number,
    usage: parseUsage(raw.usage, `${label}.usage`),
    activity: parseActivity(raw.activity, `${label}.activity`),
  };
  for (const [key, fieldLabel] of [
    ["instructions", `${label}.instructions`],
    ["sessionFile", `${label}.sessionFile`],
    ["lastActivityAt", `${label}.lastActivityAt`],
    ["currentActivity", `${label}.currentActivity`],
    ["failure", `${label}.failure`],
  ] as const) {
    const parsed = optionalString(raw[key], fieldLabel);
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
