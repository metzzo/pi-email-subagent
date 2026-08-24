import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { parseSubagentAddressShape } from "./address.ts";
import type { AddressConfig, LifecycleOverride, LifecyclePolicy, RoleConfig, SubagentConfig } from "./types.ts";

const EFFORTS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_MODEL_POLICY = `- Use model ID \`k3\` (email-domain suffix \`k3.com\`) for challenging, web-development-related, or creative tasks.
- Use model ID \`gpt-5.6-sol\` (email-domain suffix \`gpt-5.6-sol.com\`) for very difficult, complicated, or high-reasoning-dependent tasks. This higher threshold takes precedence over \`k3\`.
- Use model ID \`gpt-5.6-terra\` (email-domain suffix \`gpt-5.6-terra.com\`) only for very simple, fully explicit tasks that are not open to interpretation.
- Never use any other model unless the user explicitly requests that specific model.
- For ambiguous tasks, never choose \`gpt-5.6-terra\` if interpretation is needed; use \`k3\` unless the \`gpt-5.6-sol\` threshold is clearly met.
- If a preferred model is not currently routable, report that limitation instead of silently substituting another model.`;

/** Maximum delay Node setTimeout can represent without overflow/clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const MAX_CONFIG_ROLE_ENTRIES = 64;
export const MAX_CONFIG_ADDRESS_ENTRIES = 256;
export const MAX_CONFIG_PROFILE_TOOLS = 128;
export const MAX_CONFIG_TOOL_NAME_BYTES = 100;
export const MAX_CONFIG_INSTRUCTIONS_BYTES = 16 * 1024;
export const MAX_CONFIG_MODEL_POLICY_BYTES = 16 * 1024;
export const MAX_CONFIG_WARNINGS = 64;
const MAX_CONFIG_WARNING_BYTES = 512;
const REQUIRED_MAIL_TOOLS = ["send_email", "fetch_emails"] as const;
const UNSAFE_INLINE_CONFIG = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_MULTILINE_CONFIG = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export function isSafeConfigSemanticText(value: string, allowLayout: boolean): boolean {
  return !(allowLayout ? UNSAFE_MULTILINE_CONFIG : UNSAFE_INLINE_CONFIG).test(value);
}

function withinUtf8Bytes(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximum;
}

function utf8Prefix(value: string, maximum: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

function boundedWarning(value: string): string {
  const safe = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "");
  if (withinUtf8Bytes(safe, MAX_CONFIG_WARNING_BYTES)) return safe;
  const ellipsis = "…";
  return `${utf8Prefix(safe, MAX_CONFIG_WARNING_BYTES - Buffer.byteLength(ellipsis, "utf8"))}${ellipsis}`;
}

function finalizeWarnings(warnings: readonly string[]): string[] {
  const shown = warnings.slice(0, MAX_CONFIG_WARNINGS).map(boundedWarning);
  const omitted = warnings.length - shown.length;
  if (omitted > 0) shown.push(`${omitted} additional configuration warning(s) omitted.`);
  return shown;
}

export const DEFAULT_LIFECYCLE: LifecyclePolicy = {
  spawnTimeoutMs: 30_000,
  promptAcceptanceTimeoutMs: 30_000,
  runTimeoutMs: 4 * 60 * 60_000,
  idleTimeoutMs: 15 * 60_000,
  abortTimeoutMs: 10_000,
  disposeTimeoutMs: 10_000,
  brokerShutdownTimeoutMs: 60_000,
};

export const DEFAULT_LIFECYCLE_MAXIMA: LifecyclePolicy = {
  spawnTimeoutMs: 5 * 60_000,
  promptAcceptanceTimeoutMs: 5 * 60_000,
  runTimeoutMs: 24 * 60 * 60_000,
  idleTimeoutMs: 4 * 60 * 60_000,
  abortTimeoutMs: 60_000,
  disposeTimeoutMs: 60_000,
  brokerShutdownTimeoutMs: 2 * 60_000,
};

export const LIFECYCLE_FIELDS = Object.keys(DEFAULT_LIFECYCLE) as (keyof LifecyclePolicy)[];

export const DEFAULT_CONFIG: SubagentConfig = {
  defaultEffort: "medium",
  modelPolicy: DEFAULT_MODEL_POLICY,
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
  maxRetainedEmails: 10_000,
  responseReminderLimit: 2,
  lifecycle: { ...DEFAULT_LIFECYCLE },
  lifecycleMaxima: { ...DEFAULT_LIFECYCLE_MAXIMA },
  roles: {
    scout: {
      effort: "low",
      tools: ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
      canSpawn: false,
      instructions: "Explore and report concise evidence with paths. Do not modify files.",
    },
    reviewer: {
      effort: "high",
      tools: ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
      canSpawn: false,
      instructions: "Review for correctness and return findings with concrete paths and validation. Do not modify files.",
    },
    worker: {
      effort: "medium",
      tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "send_email", "fetch_emails"],
      canSpawn: false,
      instructions: "Implement focused changes, validate them, and report exact files and test results.",
    },
  },
  addresses: {},
};

interface RawConfig {
  defaultEffort?: unknown;
  modelPolicy?: unknown;
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
  maxRetainedEmails?: unknown;
  responseReminderLimit?: unknown;
  lifecycle?: unknown;
  lifecycleMaxima?: unknown;
  roles?: unknown;
  addresses?: unknown;
}

export interface LoadConfigResult {
  config: SubagentConfig;
  warnings: string[];
}

function readJson(path: string, warnings: string[]): RawConfig | undefined {
  if (!existsSync(path)) return undefined;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    warnings.push(`Could not read configuration file ${path}; ignoring it.`);
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`Configuration file ${path} must contain a top-level object; ignoring it.`);
      return undefined;
    }
    return parsed as RawConfig;
  } catch {
    warnings.push(`Configuration file ${path} is not valid JSON; ignoring it.`);
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
    warnings.push(`${label} has an invalid effort; using ${fallback}.`);
    return fallback;
  }
  return value as ThinkingLevel;
}

const ROLE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

function profileRecord(
  value: unknown,
  label: string,
  warnings: string[],
  kind: "role" | "address",
): Record<string, RoleConfig> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`${label} must be an object; ignoring it.`);
    return {};
  }
  const entries = Object.entries(value);
  const maximum = kind === "role" ? MAX_CONFIG_ROLE_ENTRIES : MAX_CONFIG_ADDRESS_ENTRIES;
  if (entries.length > maximum) {
    warnings.push(`${label} must contain at most ${maximum} source properties before canonicalization; ignoring the entire object.`);
    return {};
  }
  const result: Record<string, RoleConfig> = {};
  for (const [index, [sourceKey, raw]] of entries.entries()) {
    const entryLabel = `${label} entry ${index + 1}`;
    let key = sourceKey.trim().toLowerCase();
    try {
      if (kind === "role") {
        if (!ROLE_NAME.test(key)) throw new Error("invalid role key");
      } else key = parseSubagentAddressShape(key).address;
    } catch {
      warnings.push(`${entryLabel} has an invalid ${kind} key; ignoring it.`);
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(`${entryLabel} must be an object; ignoring it.`);
      continue;
    }
    if (result[key]) warnings.push(`${entryLabel} duplicates canonical key ${key}; later fields override earlier fields.`);
    const entry = raw as Record<string, unknown>;
    const next: RoleConfig = {};
    if (entry.effort !== undefined) next.effort = effort(entry.effort, "medium", entryLabel, warnings);
    if (entry.tools !== undefined) {
      if (!Array.isArray(entry.tools) || !entry.tools.every((tool) => typeof tool === "string")) {
        warnings.push(`${entryLabel}.tools must be an array of strings; ignoring the entire tools field.`);
      } else {
        const unique = [...new Set(entry.tools as string[])];
        const effectiveCount = new Set([...unique, ...REQUIRED_MAIL_TOOLS]).size;
        if (entry.tools.length > MAX_CONFIG_PROFILE_TOOLS || effectiveCount > MAX_CONFIG_PROFILE_TOOLS) {
          warnings.push(`${entryLabel}.tools must resolve to at most ${MAX_CONFIG_PROFILE_TOOLS} unique names including required mail tools; ignoring the entire tools field.`);
        } else if (unique.some((tool) => !tool || !withinUtf8Bytes(tool, MAX_CONFIG_TOOL_NAME_BYTES))) {
          warnings.push(`${entryLabel}.tools names must be non-empty and at most ${MAX_CONFIG_TOOL_NAME_BYTES} UTF-8 bytes; ignoring the entire tools field.`);
        } else if (unique.some((tool) => !isSafeConfigSemanticText(tool, false))) {
          warnings.push(`${entryLabel}.tools names must not contain control or bidirectional-control characters; ignoring the entire tools field.`);
        } else next.tools = unique;
      }
    }
    if (entry.instructions !== undefined) {
      if (typeof entry.instructions !== "string") {
        warnings.push(`${entryLabel}.instructions must be a string; ignoring the entire instructions field.`);
      } else if (!withinUtf8Bytes(entry.instructions, MAX_CONFIG_INSTRUCTIONS_BYTES)) {
        warnings.push(`${entryLabel}.instructions must be at most ${MAX_CONFIG_INSTRUCTIONS_BYTES} UTF-8 bytes; ignoring the entire instructions field.`);
      } else if (!isSafeConfigSemanticText(entry.instructions, true)) {
        warnings.push(`${entryLabel}.instructions must not contain control or bidirectional-control characters; ignoring the entire instructions field.`);
      } else next.instructions = entry.instructions;
    }
    if (entry.canSpawn !== undefined) {
      if (typeof entry.canSpawn === "boolean") next.canSpawn = entry.canSpawn;
      else warnings.push(`${entryLabel}.canSpawn must be a boolean; ignoring it.`);
    }
    if (entry.lifecycle !== undefined) {
      const parsedLifecycle = lifecycleOverride(entry.lifecycle, `${entryLabel}.lifecycle`, warnings);
      if (parsedLifecycle.brokerShutdownTimeoutMs !== undefined) {
        warnings.push(`${entryLabel}.lifecycle.brokerShutdownTimeoutMs is global administrator-only configuration; ignoring it.`);
        delete parsedLifecycle.brokerShutdownTimeoutMs;
      }
      next.lifecycle = parsedLifecycle;
    }
    result[key] = { ...(result[key] ?? {}), ...next };
  }
  return result;
}

function roleRecord(value: unknown, label: string, warnings: string[]): Record<string, RoleConfig> {
  return profileRecord(value, label, warnings, "role");
}

function addressRecord(value: unknown, label: string, warnings: string[]): Record<string, AddressConfig> {
  return profileRecord(value, label, warnings, "address");
}

function mergeProfiles<T extends RoleConfig>(base: Record<string, T>, overlay: Record<string, T>): Record<string, T> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const prior = base[key] ?? {} as T;
    result[key] = {
      ...prior,
      ...value,
      ...(prior.lifecycle || value.lifecycle ? { lifecycle: { ...prior.lifecycle, ...value.lifecycle } } : {}),
    } as T;
  }
  return result;
}

function mergeBoundedProfiles<T extends RoleConfig>(
  base: Record<string, T>,
  overlay: Record<string, T>,
  label: string,
  maximum: number,
  warnings: string[],
): Record<string, T> {
  const merged = mergeProfiles(base, overlay);
  if (Object.keys(merged).length <= maximum) return merged;
  warnings.push(`${label} would exceed the ${maximum}-entry canonical limit; ignoring this layer's entire profile object.`);
  return base;
}

function lifecycleOverride(value: unknown, label: string, warnings: string[]): LifecycleOverride {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`${label} must be an object; ignoring it.`);
    return {};
  }
  const raw = value as Record<string, unknown>;
  const result: LifecycleOverride = {};
  for (const key of LIFECYCLE_FIELDS) {
    const candidate = raw[key];
    if (candidate === undefined) continue;
    if (!Number.isInteger(candidate) || (candidate as number) < 1 || (candidate as number) > MAX_TIMER_DELAY_MS) {
      warnings.push(`${label}.${key} must be an integer from 1 to ${MAX_TIMER_DELAY_MS} (the runtime-safe timer maximum); ignoring it.`);
    } else result[key] = candidate as number;
  }
  let unknownIndex = 0;
  for (const key of Object.keys(raw)) {
    if (!LIFECYCLE_FIELDS.includes(key as keyof LifecyclePolicy)) {
      unknownIndex += 1;
      warnings.push(`${label} contains unknown field ${unknownIndex}; ignoring it.`);
    }
  }
  return result;
}

function mergeLifecycle(base: LifecyclePolicy, override: LifecycleOverride): LifecyclePolicy {
  return { ...base, ...override };
}

function mergeLayer(base: SubagentConfig, raw: RawConfig | undefined, label: string, warnings: string[]): SubagentConfig {
  if (!raw) return base;
  const defaultEffort = effort(raw.defaultEffort, base.defaultEffort, `${label}.defaultEffort`, warnings);
  let modelPolicy = base.modelPolicy;
  if (raw.modelPolicy !== undefined) {
    if (typeof raw.modelPolicy !== "string" || !raw.modelPolicy.trim()) {
      warnings.push(`${label}.modelPolicy must be a non-empty string; ignoring it.`);
    } else if (!withinUtf8Bytes(raw.modelPolicy, MAX_CONFIG_MODEL_POLICY_BYTES)) {
      warnings.push(`${label}.modelPolicy must be at most ${MAX_CONFIG_MODEL_POLICY_BYTES} UTF-8 bytes; ignoring it.`);
    } else if (!isSafeConfigSemanticText(raw.modelPolicy, true)) {
      warnings.push(`${label}.modelPolicy must not contain control or bidirectional-control characters; ignoring it.`);
    } else modelPolicy = raw.modelPolicy;
  }
  const maxAgents = positiveInt(raw.maxAgents, base.maxAgents, `${label}.maxAgents`, warnings, 64);
  const maxConcurrent = Math.min(
    maxAgents,
    positiveInt(raw.maxConcurrent, base.maxConcurrent, `${label}.maxConcurrent`, warnings, 32),
  );
  const lifecycleMaxima = mergeLifecycle(base.lifecycleMaxima, lifecycleOverride(raw.lifecycleMaxima, `${label}.lifecycleMaxima`, warnings));
  const requestedLifecycle = mergeLifecycle(base.lifecycle, lifecycleOverride(raw.lifecycle, `${label}.lifecycle`, warnings));
  const lifecycle = { ...requestedLifecycle };
  for (const key of LIFECYCLE_FIELDS) {
    if (lifecycle[key] > lifecycleMaxima[key]) {
      warnings.push(`${label}.lifecycle.${key} exceeds administrative maximum ${lifecycleMaxima[key]}; using the maximum.`);
      lifecycle[key] = lifecycleMaxima[key];
    }
  }
  return {
    defaultEffort,
    modelPolicy,
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
      512 * 1024,
    ),
    maxRetainedEmails: positiveInt(
      raw.maxRetainedEmails,
      base.maxRetainedEmails,
      `${label}.maxRetainedEmails`,
      warnings,
      1_000_000,
    ),
    responseReminderLimit: positiveInt(
      raw.responseReminderLimit,
      base.responseReminderLimit,
      `${label}.responseReminderLimit`,
      warnings,
      10,
    ),
    lifecycle,
    lifecycleMaxima,
    roles: mergeBoundedProfiles(
      base.roles,
      roleRecord(raw.roles, `${label}.roles`, warnings),
      `${label}.roles`,
      MAX_CONFIG_ROLE_ENTRIES,
      warnings,
    ),
    addresses: mergeBoundedProfiles(
      base.addresses,
      addressRecord(raw.addresses, `${label}.addresses`, warnings),
      `${label}.addresses`,
      MAX_CONFIG_ADDRESS_ENTRIES,
      warnings,
    ),
  };
}

export function loadConfig(
  agentDir: string,
  cwd: string,
  projectTrusted: boolean,
  configDirName = PiCodingAgent.CONFIG_DIR_NAME,
): LoadConfigResult {
  const warnings: string[] = [];
  let config = structuredClone(DEFAULT_CONFIG);
  config = mergeLayer(config, readJson(join(agentDir, "subagents.json"), warnings), "global", warnings);
  if (projectTrusted) {
    config = mergeLayer(config, readJson(join(cwd, configDirName, "subagents.json"), warnings), "project", warnings);
  }
  return { config, warnings: finalizeWarnings(warnings) };
}

export function resolveAgentProfile(
  config: SubagentConfig,
  address: string,
  name: string,
): Required<Pick<RoleConfig, "effort" | "tools" | "canSpawn">> & Pick<RoleConfig, "instructions"> {
  const role = config.roles[name] ?? {};
  const exact = config.addresses[address] ?? {};
  const tools = exact.tools ?? role.tools ?? ["read", "grep", "find", "ls", ...REQUIRED_MAIL_TOOLS];
  const merged = {
    effort: exact.effort ?? role.effort ?? config.defaultEffort,
    tools: [...new Set([...tools, ...REQUIRED_MAIL_TOOLS])],
    canSpawn: exact.canSpawn ?? role.canSpawn ?? false,
  } as Required<Pick<RoleConfig, "effort" | "tools" | "canSpawn">> & Pick<RoleConfig, "instructions">;
  const instructions = exact.instructions ?? role.instructions;
  if (instructions !== undefined) merged.instructions = instructions;
  return merged;
}

export function resolveLifecycle(
  config: SubagentConfig,
  address: string,
  name: string,
  initialOverride?: LifecycleOverride,
): LifecyclePolicy {
  const role = config.roles[name]?.lifecycle ?? {};
  const exact = config.addresses[address]?.lifecycle ?? {};
  const override = initialOverride ?? {};
  const result = {} as LifecyclePolicy;
  for (const key of LIFECYCLE_FIELDS) {
    // Broker shutdown coordinates all identities and cannot be delegated.
    const value = key === "brokerShutdownTimeoutMs"
      ? config.lifecycle[key]
      : override[key] ?? exact[key] ?? role[key] ?? config.lifecycle[key];
    if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
      throw new Error(`lifecycle.${key} must be an integer from 1 to ${MAX_TIMER_DELAY_MS} (the runtime-safe timer maximum).`);
    }
    if (value > config.lifecycleMaxima[key]) {
      throw new Error(`lifecycle.${key} (${value}) exceeds the administrative maximum ${config.lifecycleMaxima[key]}. Choose a smaller finite value.`);
    }
    result[key] = value;
  }
  return result;
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return EFFORTS.has(value as ThinkingLevel);
}
