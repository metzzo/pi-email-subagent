import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { AddressConfig, RoleConfig, SubagentConfig } from "./types.ts";

const EFFORTS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_CONFIG: SubagentConfig = {
  defaultEffort: "medium",
  maxAgents: 8,
  maxConcurrent: 4,
  maxMessageBytes: 32 * 1024,
  maxSubjectBytes: 512,
  maxMailsPerMinute: 60,
  maxMailsPerSenderPerMinute: 30,
  maxQueuedMessages: 256,
  maxQueuedBytes: 4 * 1024 * 1024,
  maxBatchMessages: 32,
  maxBatchBytes: 512 * 1024,
  responseReminderLimit: 2,
  roles: {
    scout: {
      effort: "low",
      tools: ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
      instructions: "Explore and report concise evidence with paths. Do not modify files.",
    },
    reviewer: {
      effort: "high",
      tools: ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
      instructions: "Review for correctness and return findings with concrete paths and validation. Do not modify files.",
    },
    worker: {
      effort: "medium",
      tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "send_email", "fetch_emails"],
      instructions: "Implement focused changes, validate them, and report exact files and test results.",
    },
  },
  addresses: {},
};

interface RawConfig {
  defaultEffort?: unknown;
  maxAgents?: unknown;
  maxConcurrent?: unknown;
  maxMessageBytes?: unknown;
  maxSubjectBytes?: unknown;
  maxMailsPerMinute?: unknown;
  maxMailsPerSenderPerMinute?: unknown;
  maxQueuedMessages?: unknown;
  maxQueuedBytes?: unknown;
  maxBatchMessages?: unknown;
  maxBatchBytes?: unknown;
  responseReminderLimit?: unknown;
  roles?: unknown;
  addresses?: unknown;
}

export interface LoadConfigResult {
  config: SubagentConfig;
  warnings: string[];
}

function readJson(path: string, warnings: string[]): RawConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("top level must be an object");
    return parsed as RawConfig;
  } catch (error) {
    warnings.push(`Could not load ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function positiveInt(value: unknown, fallback: number, label: string, warnings: string[], max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    warnings.push(`${label} must be an integer from 1 to ${max}; using ${fallback}.`);
    return fallback;
  }
  return value as number;
}

function effort(value: unknown, fallback: ThinkingLevel, label: string, warnings: string[]): ThinkingLevel {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !EFFORTS.has(value as ThinkingLevel)) {
    warnings.push(`${label} has invalid effort \"${String(value)}\"; using ${fallback}.`);
    return fallback;
  }
  return value as ThinkingLevel;
}

function roleRecord(value: unknown, label: string, warnings: string[]): Record<string, RoleConfig> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`${label} must be an object; ignoring it.`);
    return {};
  }
  const result: Record<string, RoleConfig> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(`${label}.${name} must be an object; ignoring it.`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const next: RoleConfig = {};
    if (entry.effort !== undefined) next.effort = effort(entry.effort, "medium", `${label}.${name}`, warnings);
    if (entry.tools !== undefined) {
      if (Array.isArray(entry.tools) && entry.tools.every((tool) => typeof tool === "string")) {
        next.tools = [...new Set(entry.tools as string[])];
      } else warnings.push(`${label}.${name}.tools must be an array of strings; ignoring it.`);
    }
    if (entry.instructions !== undefined) {
      if (typeof entry.instructions === "string") next.instructions = entry.instructions;
      else warnings.push(`${label}.${name}.instructions must be a string; ignoring it.`);
    }
    result[name.toLowerCase()] = next;
  }
  return result;
}

function addressRecord(value: unknown, label: string, warnings: string[]): Record<string, AddressConfig> {
  return roleRecord(value, label, warnings);
}

function mergeProfiles<T extends RoleConfig>(base: Record<string, T>, overlay: Record<string, T>): Record<string, T> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) result[key] = { ...(base[key] ?? {}), ...value } as T;
  return result;
}

function mergeLayer(base: SubagentConfig, raw: RawConfig | undefined, label: string, warnings: string[]): SubagentConfig {
  if (!raw) return base;
  const defaultEffort = effort(raw.defaultEffort, base.defaultEffort, `${label}.defaultEffort`, warnings);
  const maxAgents = positiveInt(raw.maxAgents, base.maxAgents, `${label}.maxAgents`, warnings, 64);
  const maxConcurrent = Math.min(
    maxAgents,
    positiveInt(raw.maxConcurrent, base.maxConcurrent, `${label}.maxConcurrent`, warnings, 32),
  );
  return {
    defaultEffort,
    maxAgents,
    maxConcurrent,
    maxMessageBytes: positiveInt(raw.maxMessageBytes, base.maxMessageBytes, `${label}.maxMessageBytes`, warnings, 1024 * 1024),
    maxSubjectBytes: positiveInt(raw.maxSubjectBytes, base.maxSubjectBytes, `${label}.maxSubjectBytes`, warnings, 8192),
    maxMailsPerMinute: positiveInt(raw.maxMailsPerMinute, base.maxMailsPerMinute, `${label}.maxMailsPerMinute`, warnings, 10_000),
    maxMailsPerSenderPerMinute: positiveInt(
      raw.maxMailsPerSenderPerMinute,
      base.maxMailsPerSenderPerMinute,
      `${label}.maxMailsPerSenderPerMinute`,
      warnings,
      10_000,
    ),
    maxQueuedMessages: positiveInt(
      raw.maxQueuedMessages,
      base.maxQueuedMessages,
      `${label}.maxQueuedMessages`,
      warnings,
      10_000,
    ),
    maxQueuedBytes: positiveInt(
      raw.maxQueuedBytes,
      base.maxQueuedBytes,
      `${label}.maxQueuedBytes`,
      warnings,
      64 * 1024 * 1024,
    ),
    maxBatchMessages: positiveInt(
      raw.maxBatchMessages,
      base.maxBatchMessages,
      `${label}.maxBatchMessages`,
      warnings,
      1_024,
    ),
    maxBatchBytes: positiveInt(
      raw.maxBatchBytes,
      base.maxBatchBytes,
      `${label}.maxBatchBytes`,
      warnings,
      16 * 1024 * 1024,
    ),
    responseReminderLimit: positiveInt(
      raw.responseReminderLimit,
      base.responseReminderLimit,
      `${label}.responseReminderLimit`,
      warnings,
      10,
    ),
    roles: mergeProfiles(base.roles, roleRecord(raw.roles, `${label}.roles`, warnings)),
    addresses: mergeProfiles(base.addresses, addressRecord(raw.addresses, `${label}.addresses`, warnings)),
  };
}

export function loadConfig(
  agentDir: string,
  cwd: string,
  projectTrusted: boolean,
  configDirName = CONFIG_DIR_NAME,
): LoadConfigResult {
  const warnings: string[] = [];
  let config = structuredClone(DEFAULT_CONFIG);
  config = mergeLayer(config, readJson(join(agentDir, "subagents.json"), warnings), "global", warnings);
  if (projectTrusted) {
    config = mergeLayer(config, readJson(join(cwd, configDirName, "subagents.json"), warnings), "project", warnings);
  }
  return { config, warnings };
}

export function resolveAgentProfile(config: SubagentConfig, address: string, name: string): Required<Pick<RoleConfig, "effort" | "tools">> & Pick<RoleConfig, "instructions"> {
  const role = config.roles[name] ?? {};
  const exact = config.addresses[address] ?? {};
  const tools = exact.tools ?? role.tools ?? ["read", "grep", "find", "ls", "send_email", "fetch_emails"];
  const merged = {
    effort: exact.effort ?? role.effort ?? config.defaultEffort,
    tools: [...new Set([...tools, "send_email", "fetch_emails"])],
  } as Required<Pick<RoleConfig, "effort" | "tools">> & Pick<RoleConfig, "instructions">;
  const instructions = exact.instructions ?? role.instructions;
  if (instructions !== undefined) merged.instructions = instructions;
  return merged;
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return EFFORTS.has(value as ThinkingLevel);
}
