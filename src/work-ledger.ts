import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentWorkState, WorkCounters, WorkItem, WorkKind } from "./types.ts";
import { safeErrorSummary } from "./safe-summary.ts";

export const MAX_RECENT_WORK = 48;
export const MAX_ACTIVE_WORK = 64;
export const MAX_PATCH_BYTES = 8 * 1024;
export const MAX_PATCH_LINES = 200;
export const MAX_COMMAND_CHARS = 240;
export const MAX_ERROR_CHARS = 500;

const INSPECTION = new Set(["read", "grep", "find", "ls"]);
const MAILBOX = new Set(["send_email", "fetch_emails"]);

export type ToolClass = "edit" | "write" | "shell" | "inspection" | "mailbox" | "custom";

export function classifyTool(name: string): ToolClass {
  if (name === "edit" || name === "write") return name;
  if (name === "bash") return "shell";
  if (INSPECTION.has(name)) return "inspection";
  if (MAILBOX.has(name)) return "mailbox";
  return "custom";
}

export function emptyWorkState(): AgentWorkState {
  return { nextBatchId: 1, active: [], recent: [], inspection: { reads: 0, searches: 0, listings: 0 } };
}

export function countWrite(content: unknown): { bytesWritten?: number; linesWritten?: number } {
  if (typeof content !== "string") return {};
  const linesWritten = content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length - (/(?:\r\n|\r|\n)$/.test(content) ? 1 : 0);
  return { bytesWritten: Buffer.byteLength(content, "utf8"), linesWritten };
}

function canonicalizeNearest(path: string): string {
  let parent = path; const suffix: string[] = [];
  while (!existsSync(parent)) {
    const next = dirname(parent); if (next === parent) return path;
    suffix.unshift(basename(parent)); parent = next;
  }
  try { return join(realpathSync(parent), ...suffix); } catch { return path; }
}

const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function normalizeToolPath(input: string): string | undefined {
  let value = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = homedir(); else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
  if (/^file:\/\//.test(value)) { try { value = fileURLToPath(value); } catch { return undefined; } }
  return value;
}

export function sanitizeWorkPath(input: unknown): string | undefined {
  if (typeof input !== "string" || !input.trim() || input.length > 2_000 || Buffer.byteLength(input, "utf8") > 8_192 || UNSAFE_PATH.test(input)) return undefined;
  return input;
}

export function displayWorkPath(input: unknown, cwd: string): { path?: string; displayPath?: string } {
  if (typeof input !== "string") return {};
  const normalized = sanitizeWorkPath(normalizeToolPath(input));
  if (!normalized) return {};
  const canonicalCwd = canonicalizeNearest(resolve(cwd));
  if (!sanitizeWorkPath(canonicalCwd)) return {};
  const absolute = canonicalizeNearest(resolve(canonicalCwd, normalized));
  if (!sanitizeWorkPath(absolute)) return {};
  const rel = relative(canonicalCwd, absolute);
  const inside = rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  return { path: absolute, displayPath: inside ? (rel || ".") : `(absolute) ${absolute}` };
}

export function capText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b[P_X^][\s\S]*?\x1b\\/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let output = ""; let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    output += character; bytes += size;
  }
  return output;
}

export function capPatch(value: unknown): { patchPreview?: string; patchTruncated?: boolean } {
  if (typeof value !== "string" || !value) return {};
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
  const lines = normalized.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= MAX_PATCH_LINES) break;
    const next = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0);
    if (bytes + next > MAX_PATCH_BYTES) {
      const remaining = MAX_PATCH_BYTES - bytes - (kept.length ? 1 : 0);
      if (remaining > 0) kept.push(utf8Prefix(line, remaining));
      break;
    }
    kept.push(line);
    bytes += next;
  }
  const preview = kept.join("\n");
  return { patchPreview: preview, patchTruncated: kept.length < lines.length || Buffer.byteLength(normalized, "utf8") > MAX_PATCH_BYTES };
}

export function patchStats(value: unknown): { linesAdded?: number; linesRemoved?: number } {
  if (typeof value !== "string") return {};
  let linesAdded = 0; let linesRemoved = 0; let inHunk = false; let sawHunk = false;
  for (const line of value.split(/\r\n|\r|\n/)) {
    if (line.startsWith("diff ")) { inHunk = false; continue; }
    if (line.startsWith("@@")) { inHunk = true; sawHunk = true; continue; }
    if (!inHunk && (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index "))) continue;
    if ((inHunk || !sawHunk) && line.startsWith("+")) linesAdded += 1;
    else if ((inHunk || !sawHunk) && line.startsWith("-")) linesRemoved += 1;
  }
  return { linesAdded, linesRemoved };
}

export function extractError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return safeErrorSummary(result ?? "Tool failed");
  const raw = result as Record<string, unknown>;
  if (Array.isArray(raw.content)) {
    const text = raw.content.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text : "").filter(Boolean).join("\n");
    if (text) return safeErrorSummary(text);
  }
  return safeErrorSummary(typeof raw.error === "string" ? raw.error : "Tool failed");
}

function argsObject(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

export function startWorkItem(toolCallId: string, toolName: string, args: unknown, batchId: number, cwd: string, at = new Date().toISOString()): WorkItem | undefined {
  const toolClass = classifyTool(toolName);
  if (toolClass === "inspection" || toolClass === "mailbox") return undefined;
  const input = argsObject(args);
  const safeId = capText(toolCallId, 200) ?? "unknown";
  const safeName = capText(toolName, 100) ?? "unknown";
  const base: WorkItem = {
    toolCallId: safeId, batchId, toolName: safeName, kind: toolClass === "shell" ? "shell" : toolClass as WorkKind,
    attribution: toolClass === "edit" || toolClass === "write" ? "explicit" : "unverified", status: "running", startedAt: at,
  };
  if (toolClass === "edit" || toolClass === "write") Object.assign(base, displayWorkPath(input.path ?? input.file_path, cwd));
  if (toolClass === "edit") {
    let edits = input.edits;
    if (typeof edits === "string") { try { edits = JSON.parse(edits); } catch { /* invalid raw intent */ } }
    base.editBlocks = Array.isArray(edits) ? edits.length : (typeof input.oldText === "string" && typeof input.newText === "string" ? 1 : undefined);
  }
  if (toolClass === "write") Object.assign(base, countWrite(input.content));
  if (toolClass === "shell") base.commandPreview = capText(input.command, MAX_COMMAND_CHARS);
  if (toolClass === "custom") {
    const hint = typeof input.path === "string" ? input.path : typeof input.target === "string" ? input.target : undefined;
    if (hint) base.commandPreview = capText(hint, MAX_COMMAND_CHARS);
  }
  return base;
}

export function noteInspection(counters: WorkCounters, toolName: string): void {
  if (toolName === "read") counters.reads += 1;
  else if (toolName === "grep" || toolName === "find") counters.searches += 1;
  else if (toolName === "ls") counters.listings += 1;
}

export function finishWorkItem(item: WorkItem, result: unknown, isError: boolean, endedAt = new Date().toISOString()): WorkItem {
  const complete: WorkItem = { ...item, status: isError ? "failed" : "succeeded", endedAt };
  const start = Date.parse(item.startedAt); const end = Date.parse(endedAt);
  if (Number.isFinite(start) && Number.isFinite(end)) complete.durationMs = Math.max(0, end - start);
  if (!isError && item.attribution === "explicit" && !item.path) isError = true;
  complete.status = isError ? "failed" : "succeeded";
  if (isError) complete.error = item.attribution === "explicit" ? `${item.toolName} failed` : extractError(result);
  if (!isError && item.kind === "edit" && result && typeof result === "object") {
    const details = (result as Record<string, unknown>).details;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const raw = details as Record<string, unknown>;
      const patch = typeof raw.patch === "string" ? raw.patch : raw.diff;
      Object.assign(complete, patchStats(patch), capPatch(patch));
      if (complete.patchPreview) complete.patchSource = "event";
      if (Number.isInteger(raw.firstChangedLine) && (raw.firstChangedLine as number) >= 0) complete.firstChangedLine = raw.firstChangedLine as number;
    }
  }
  return complete;
}

export function appendRecent(state: AgentWorkState, item: WorkItem): void {
  state.recent = [...state.recent.filter((entry) => entry.toolCallId !== item.toolCallId), item].slice(-MAX_RECENT_WORK);
}

export function interruptActive(state: AgentWorkState, at = new Date().toISOString()): void {
  for (const item of state.active) appendRecent(state, { ...item, status: "interrupted", endedAt: at });
  state.active = [];
}

export function beginBatch(state: AgentWorkState, at = new Date().toISOString()): number {
  interruptActive(state, at);
  const batch = Math.max(1, state.nextBatchId);
  state.currentBatchId = batch; state.nextBatchId = batch + 1; state.batchStartedAt = at; delete state.batchEndedAt;
  state.inspection = { reads: 0, searches: 0, listings: 0 };
  return batch;
}

export function aggregateWork(state: AgentWorkState, batchId = state.currentBatchId): { files: number; linesAdded: number; linesRemoved: number; writes: number; unverified: number; statsUnknown: boolean } {
  const confirmed = state.recent.filter((item) => item.batchId === batchId && item.status === "succeeded" && item.attribution === "explicit");
  return {
    files: new Set(confirmed.map((item) => item.path).filter(Boolean)).size,
    linesAdded: confirmed.reduce((sum, item) => sum + (item.linesAdded ?? 0), 0),
    linesRemoved: confirmed.reduce((sum, item) => sum + (item.linesRemoved ?? 0), 0),
    writes: confirmed.filter((item) => item.kind === "write").length,
    statsUnknown: confirmed.some((item) => item.kind === "edit" && (item.linesAdded === undefined || item.linesRemoved === undefined)),
    unverified: state.recent.filter((item) => item.batchId === batchId && item.attribution === "unverified").length,
  };
}

export function currentBatchHasEffectfulWork(state: AgentWorkState | undefined): boolean {
  if (!state || state.currentBatchId === undefined) return false;
  const batchId = state.currentBatchId;
  return [...state.active, ...state.recent].some((item) => item.batchId === batchId);
}

export function activePathConflicts(records: readonly { address: string; work?: AgentWorkState }[]): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  for (const record of records) for (const item of record.work?.active ?? []) {
    if (item.attribution !== "explicit" || !item.path) continue;
    paths.set(item.path, [...new Set([...(paths.get(item.path) ?? []), record.address])]);
  }
  return new Map([...paths].filter(([, addresses]) => addresses.length > 1));
}

export function recoverMutationWork(entries: readonly unknown[], cwd: string, existing: AgentWorkState = emptyWorkState()): AgentWorkState {
  const state: AgentWorkState = { ...existing, active: [...existing.active], recent: [...existing.recent], inspection: { ...existing.inspection } };
  interruptActive(state);
  const calls = new Map<string, WorkItem>();
  let recoveredBatch = 0;
  for (const candidate of entries.slice(-10_000)) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Record<string, unknown>;
    if (entry.type === "custom" && entry.customType === "pi-email-subagent-work-batch" && entry.data && typeof entry.data === "object") {
      const marker = entry.data as Record<string, unknown>;
      if (Number.isSafeInteger(marker.batchId) && (marker.batchId as number) > 0) {
        recoveredBatch = marker.batchId as number;
        state.currentBatchId = Math.max(state.currentBatchId ?? 0, recoveredBatch);
        state.nextBatchId = Math.max(state.nextBatchId, recoveredBatch + 1);
        if (typeof marker.startedAt === "string" && Number.isFinite(Date.parse(marker.startedAt))) state.batchStartedAt = marker.startedAt;
      }
      continue;
    }
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const raw = message as Record<string, unknown>;
    if (raw.role === "assistant" && Array.isArray(raw.content)) for (const block of raw.content) {
      if (!block || typeof block !== "object") continue;
      const part = block as Record<string, unknown>;
      if (part.type !== "toolCall" || typeof part.id !== "string" || (part.name !== "edit" && part.name !== "write")) continue;
      const call = startWorkItem(part.id, part.name, part.arguments, recoveredBatch, cwd, typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString());
      if (call) calls.set(part.id, call);
    }
    if (raw.role === "toolResult" && typeof raw.toolCallId === "string" && (raw.toolName === "edit" || raw.toolName === "write")) {
      const call = calls.get(raw.toolCallId);
      if (!call || call.toolName !== raw.toolName || !call.path) continue;
      const cached = state.recent.find((item) => item.toolCallId === raw.toolCallId);
      const base: WorkItem = cached && cached.attribution === "explicit" && cached.kind === call.kind
        ? { ...call, startedAt: cached.startedAt, batchId: cached.batchId, path: cached.path ?? call.path, displayPath: cached.displayPath ?? call.displayPath }
        : call;
      const terminal = finishWorkItem(base, { content: raw.content, details: raw.details }, raw.isError === true, typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString());
      if (terminal.patchPreview) terminal.patchSource = "session";
      appendRecent(state, terminal);
    }
  }
  return state;
}
