import { readFile, stat } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { migrateSessionEntries, parseSessionEntries, renderDiff, truncateHead, type ExtensionContext, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentBroker } from "./broker.ts";
import { isThinkingLevel } from "./config.ts";
import type { AgentInspection, AgentRecord, BrokerSnapshot, SendEmailInput, WorkItem } from "./types.ts";
import { activePathConflicts, aggregateWork, capPatch, countWrite, currentBatchHasEffectfulWork } from "./work-ledger.ts";
import { errorMessage, truncateText } from "./util.ts";

interface DashboardAction {
  kind: "close" | "compose" | "conversation" | "diff" | "stop" | "restart" | "archive" | "clear_failure" | "effort";
  address?: string;
  workItem?: WorkItem;
}

const CLOSED_STATES = new Set<AgentRecord["state"]>(["paused", "stopped", "archived"]);

function displayStatus(state: AgentRecord["state"]): AgentRecord["state"] | "closed" {
  return CLOSED_STATES.has(state) ? "closed" : state;
}

function statusIcon(state: AgentRecord["state"]): string {
  if (CLOSED_STATES.has(state)) return "■";
  switch (state) {
    case "running": return "●";
    case "queued": return "◷";
    case "idle": return "○";
    case "failed": return "✗";
    case "spawning": return "◌";
    default: return "■";
  }
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export interface ConversationBlock {
  at: string;
  role: "user" | "assistant" | "tool" | "system" | "error";
  label: string;
  body: string;
}

function stripTerminalSequences(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x9d[^\x07\x9c]*(?:\x07|\x9c)/g, "")
    .replace(/\x1b[P_X^][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function sanitizeConversationBody(value: string): string {
  return stripTerminalSequences(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "  ");
}

export function sanitizeConversationLabel(value: string): string {
  return sanitizeConversationBody(value).replace(/\s+/g, " ").trim();
}

function safeActivitySummary(value: string): string {
  const clean = sanitizeConversationLabel(value);
  if (/^(?:edit|write)\s+\{/i.test(clean)) return `${clean.split(/\s/, 1)[0]} (legacy mutation arguments hidden)`;
  return clean;
}

function visibleMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push(`[image: ${String(block.mimeType ?? block.mediaType ?? "unknown")}]`);
    else if (block.type === "toolCall") {
      const name = String(block.name ?? "tool");
      const args = block.arguments && typeof block.arguments === "object" ? block.arguments as Record<string, unknown> : {};
      if (name === "write") {
        const size = countWrite(args.content);
        parts.push(`✎ write ${truncateText(String(args.path ?? "(unknown path)"), 500)} · ${size.bytesWritten ?? "?"} bytes · ${size.linesWritten ?? "?"} lines`);
      } else if (name === "edit") {
        const blocks = Array.isArray(args.edits) ? args.edits.length : (typeof args.oldText === "string" ? 1 : 0);
        parts.push(`✎ edit ${truncateText(String(args.path ?? "(unknown path)"), 500)} · ${blocks} replacement block${blocks === 1 ? "" : "s"}`);
      } else if (name === "bash") parts.push(`→ bash ${truncateText(String(args.command ?? ""), 240)}`);
      else if (name === "read" || name === "grep" || name === "find" || name === "ls") parts.push(`→ ${name} ${truncateText(String(args.path ?? args.pattern ?? ""), 500)}`);
      else if (name === "send_email") parts.push(`→ send_email ${truncateText(String(args.to ?? ""), 200)} · ${truncateText(String(args.subject ?? ""), 200)} · body hidden`);
      else if (name === "fetch_emails") parts.push("→ fetch_emails");
      else parts.push(`→ ${truncateText(name, 100)} (arguments hidden)`);
    }
    // Deliberately omit thinking blocks: the dashboard must not expose hidden reasoning.
  }
  return parts.join("\n\n");
}

export function conversationBlocks(entries: readonly SessionEntry[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  for (const entry of entries) {
    const at = typeof entry.timestamp === "string" ? entry.timestamp : "";
    if (entry.type === "message") {
      if (!entry.message || typeof entry.message !== "object") continue;
      const message = entry.message as unknown as Record<string, unknown>;
      const role = String(message.role ?? "unknown");
      if (role === "custom" && message.display === false) continue;
      const body = visibleMessageContent(message.content);
      if (role === "user") blocks.push({ at, role: "user", label: "User", body: sanitizeConversationBody(body || "(empty message)") });
      else if (role === "assistant") {
        blocks.push({ at, role: "assistant", label: "Assistant", body: sanitizeConversationBody(body || "(no visible response content)") });
      } else if (role === "toolResult") {
        const failed = message.isError === true;
        const toolName = String(message.toolName ?? "tool");
        let resultBody = body || "(empty result)";
        if ((toolName === "write" || toolName === "edit") && failed) resultBody = `${toolName} failed (mutation bodies hidden)`;
        if (toolName === "write" && !failed) resultBody = "write completed (content hidden)";
        if (toolName === "edit" && !failed && message.details && typeof message.details === "object") {
          const details = message.details as Record<string, unknown>;
          const patch = capPatch(typeof details.patch === "string" ? details.patch : details.diff);
          resultBody = patch.patchPreview || resultBody;
          if (patch.patchTruncated) resultBody += "\n[patch preview truncated; persisted tool result may contain more]";
        }
        blocks.push({
          at,
          role: failed ? "error" : "tool",
          label: sanitizeConversationLabel(`Tool result · ${toolName}`),
          body: sanitizeConversationBody(resultBody),
        });
      } else if (role === "bashExecution") {
        blocks.push({
          at,
          role: message.exitCode === 0 ? "tool" : "error",
          label: sanitizeConversationLabel(`Shell · ${String(message.command ?? "")}`),
          body: sanitizeConversationBody(String(message.output ?? "(no output)")),
        });
      } else if (role === "custom") {
        blocks.push({
          at,
          role: "system",
          label: sanitizeConversationLabel(`Context · ${String(message.customType ?? "custom")}`),
          body: sanitizeConversationBody(body || "(empty)"),
        });
      } else if (role === "branchSummary" || role === "compactionSummary") {
        blocks.push({
          at,
          role: "system",
          label: role === "branchSummary" ? "Branch summary" : "Compaction summary",
          body: sanitizeConversationBody(String(message.summary ?? body)),
        });
      }
      continue;
    }
    if (entry.type === "compaction") {
      blocks.push({ at, role: "system", label: "Compaction summary", body: sanitizeConversationBody(entry.summary) });
    } else if (entry.type === "branch_summary") {
      blocks.push({ at, role: "system", label: "Branch summary", body: sanitizeConversationBody(entry.summary) });
    } else if (entry.type === "model_change") {
      blocks.push({ at, role: "system", label: "Model changed", body: sanitizeConversationBody(`${entry.provider}/${entry.modelId}`) });
    } else if (entry.type === "thinking_level_change") {
      blocks.push({ at, role: "system", label: "Effort changed", body: sanitizeConversationBody(entry.thinkingLevel) });
    }
  }
  return blocks;
}

export function activeSessionBranch(fileEntries: readonly FileEntry[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const candidate of fileEntries as readonly unknown[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Record<string, unknown>;
    if (entry.type === "session" || typeof entry.type !== "string" || typeof entry.id !== "string") continue;
    entries.push(candidate as SessionEntry);
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionEntry[] = [];
  const visited = new Set<string>();
  let current = entries.at(-1);
  while (current && !visited.has(current.id)) {
    path.push(current);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

export async function readConversationBlocks(sessionFile: string): Promise<ConversationBlock[]> {
  const content = await readFile(sessionFile, "utf8");
  const entries = parseSessionEntries(content);
  migrateSessionEntries(entries);
  return conversationBlocks(activeSessionBranch(entries));
}

const patchIndexCache = new Map<string, { signature: string; patches: Map<string, { patch: string; truncated: boolean }> }>();

export async function readPersistedEditPatch(sessionFile: string, toolCallId: string): Promise<{ patch: string; truncated: boolean } | undefined> {
  const info = await stat(sessionFile);
  if (info.size > 20 * 1024 * 1024) throw new Error("session exceeds 20 MB diff lookup bound");
  const signature = `${info.size}:${info.mtimeMs}`;
  const cached = patchIndexCache.get(sessionFile);
  if (cached?.signature === signature) return cached.patches.get(toolCallId);
  const content = await readFile(sessionFile, "utf8");
  const entries = parseSessionEntries(content);
  migrateSessionEntries(entries);
  const patches = new Map<string, { patch: string; truncated: boolean }>();
  for (const entry of activeSessionBranch(entries)) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "edit") continue;
    const details = entry.message.details;
    if (!details || typeof details !== "object") continue;
    const raw = details as Record<string, unknown>;
    const patch = typeof raw.patch === "string" ? raw.patch : raw.diff;
    if (typeof patch !== "string" || !patch) continue;
    const capped = truncateHead(patch, { maxBytes: 50 * 1024, maxLines: 2_000 });
    patches.set(entry.message.toolCallId, { patch: capped.content, truncated: capped.truncated });
  }
  patchIndexCache.set(sessionFile, { signature, patches });
  while (patchIndexCache.size > 32) patchIndexCache.delete(patchIndexCache.keys().next().value!);
  return patches.get(toolCallId);
}

export class ConversationSource {
  private currentBlocks: ConversationBlock[] = [];
  private signature?: string;
  private inFlight?: Promise<boolean>;
  private lastCheckAt = 0;
  error?: string;

  constructor(
    readonly sessionFile: string,
    private readonly throttleMs = 250,
    private readonly maxRetainedBlocks?: number,
  ) {}

  get blocks(): readonly ConversationBlock[] {
    return this.currentBlocks;
  }

  refresh(force = false): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const now = Date.now();
    if (!force && now - this.lastCheckAt < this.throttleMs) return Promise.resolve(false);
    this.lastCheckAt = now;
    const operation = (async () => {
      try {
        const fileStat = await stat(this.sessionFile);
        const signature = `${fileStat.size}:${fileStat.mtimeMs}`;
        if (signature === this.signature) return false;
        const blocks = await readConversationBlocks(this.sessionFile);
        this.signature = signature;
        this.currentBlocks = this.maxRetainedBlocks === undefined
          ? blocks
          : blocks.slice(-Math.max(1, this.maxRetainedBlocks));
        this.error = undefined;
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Keep the last good blocks on transient failures; only surface the
        // error so a momentary stat/read problem does not blank the preview.
        const changed = this.error !== message;
        this.signature = undefined;
        this.error = message;
        return changed;
      }
    })();
    const tracked = operation.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }
}

export function formatConversationTranscript(blocks: readonly ConversationBlock[]): string {
  if (blocks.length === 0) return "(no recorded conversation yet)";
  return blocks.map((block) => {
    const time = sanitizeConversationLabel(block.at.slice(11, 19));
    return `${time} ${sanitizeConversationLabel(block.label)}\n${sanitizeConversationBody(block.body)}`;
  }).join("\n\n");
}

export const HISTORY_PREVIEW_MAX_BLOCKS = 4;
export const HISTORY_PREVIEW_MAX_CHARS = 2_000;

export function formatConversationPreview(
  blocks: readonly ConversationBlock[],
  maxBlocks = HISTORY_PREVIEW_MAX_BLOCKS,
  maxChars = HISTORY_PREVIEW_MAX_CHARS,
): string {
  const suffix = "\n\nFull transcript: /agents → select agent → Ctrl+O";
  if (blocks.length === 0) return `Conversation preview is loading or unavailable.${suffix}`.slice(0, maxChars);
  const selected = blocks.slice(-Math.max(1, maxBlocks));
  const omitted = Math.max(0, blocks.length - selected.length);
  const prefix = omitted > 0 ? `… ${omitted} earlier entries omitted …\n\n` : "";
  const available = Math.max(0, maxChars - suffix.length);
  const separators = Math.max(0, selected.length - 1) * 2;
  const perBlock = Math.max(0, Math.floor((available - prefix.length - separators) / selected.length));
  const body = selected.map((block) => {
    const time = sanitizeConversationLabel(block.at.slice(11, 19));
    const label = sanitizeConversationLabel(block.label);
    const header = `${time} ${label}`;
    const bodyBudget = Math.max(0, perBlock - header.length - 1);
    return `${header}\n${sanitizeConversationBody(block.body.slice(0, bodyBudget))}`.slice(0, perBlock);
  }).join("\n\n");
  const clipped = `${prefix}${body}`.slice(0, available);
  return `${clipped}${suffix}`.slice(0, maxChars);
}

export interface ConversationProvider {
  readonly blocks: readonly ConversationBlock[];
  readonly error?: string;
  refresh?(force?: boolean): Promise<boolean>;
}

export class ConversationComponent {
  private scrollOffset = 0;
  private pageSize = 1;
  private lastMaxOffset = 0;
  private pinnedToBottom = false;
  private cachedWidth?: number;
  private cachedContent?: string[];
  private refreshTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(
    private readonly address: string,
    private readonly source: ConversationProvider,
    private readonly done: () => void,
    private readonly requestRender: () => void,
    private readonly theme: ExtensionContext["ui"]["theme"],
    private readonly viewportRows: number,
    private readonly isConversationKey: (data: string) => boolean = (data) => matchesKey(data, Key.ctrl("o")),
    refreshIntervalMs = 500,
  ) {
    if (source.refresh && refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => { this.refresh().catch(() => undefined); }, refreshIntervalMs);
    }
  }

  private async refresh(): Promise<void> {
    if (this.disposed || !this.source.refresh) return;
    const changed = await this.source.refresh();
    if (!changed || this.disposed) return;
    this.invalidate();
    if (this.pinnedToBottom) this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.requestRender();
  }

  private contentLines(width: number): string[] {
    if (this.cachedWidth === width && this.cachedContent) return this.cachedContent;
    const lines: string[] = [];
    const bodyWidth = Math.max(1, width - 2);
    const roleColor = (role: ConversationBlock["role"]): "accent" | "success" | "muted" | "warning" | "error" => {
      if (role === "user") return "accent";
      if (role === "assistant") return "success";
      if (role === "error") return "error";
      if (role === "system") return "warning";
      return "muted";
    };
    for (const block of this.source.blocks) {
      const time = sanitizeConversationLabel(block.at.slice(11, 19));
      const label = sanitizeConversationLabel(block.label);
      lines.push(this.theme.fg(roleColor(block.role), `${time} ${label}`));
      for (const rawLine of sanitizeConversationBody(block.body).split("\n")) {
        const wrapped = wrapTextWithAnsi(this.theme.fg("text", rawLine), bodyWidth);
        if (wrapped.length === 0) lines.push("  ");
        else for (const line of wrapped) lines.push(`  ${line}`);
      }
      lines.push("");
    }
    if (lines.length === 0) lines.push(this.theme.fg("muted", "(no recorded conversation yet)"));
    this.cachedWidth = width;
    this.cachedContent = lines;
    return lines;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const content = this.contentLines(safeWidth);
    this.pageSize = Math.max(1, this.viewportRows);
    this.lastMaxOffset = Math.max(0, content.length - this.pageSize);
    if (this.pinnedToBottom) this.scrollOffset = this.lastMaxOffset;
    else this.scrollOffset = Math.min(this.scrollOffset, this.lastMaxOffset);
    const visible = content.slice(this.scrollOffset, this.scrollOffset + this.pageSize);
    const start = content.length === 0 ? 0 : this.scrollOffset + 1;
    const end = Math.min(content.length, this.scrollOffset + visible.length);
    const error = this.source.error ? ` · refresh error: ${sanitizeConversationLabel(this.source.error)}` : "";
    const lines = [
      this.theme.fg("accent", this.theme.bold(`Subagent conversation · ${sanitizeConversationLabel(this.address)}`)),
      this.theme.fg("dim", `${this.source.blocks.length} entries · lines ${start}-${end}/${content.length}${error}`),
      this.theme.fg("borderMuted", "─".repeat(Math.max(1, Math.min(safeWidth, 80)))),
      ...visible,
      this.theme.fg("borderMuted", "─".repeat(Math.max(1, Math.min(safeWidth, 80)))),
      this.theme.fg("dim", "live · ↑↓ scroll · pgup/pgdn page · home/end · ctrl+o or esc close"),
    ];
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedContent = undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || this.isConversationKey(data)) {
      this.dispose();
      this.done();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.pinnedToBottom = false;
    } else if (matchesKey(data, Key.down)) {
      this.scrollOffset = Math.min(this.lastMaxOffset, this.scrollOffset + 1);
      this.pinnedToBottom = this.scrollOffset >= this.lastMaxOffset;
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.pageSize);
      this.pinnedToBottom = false;
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(this.lastMaxOffset, this.scrollOffset + this.pageSize);
      this.pinnedToBottom = this.scrollOffset >= this.lastMaxOffset;
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.pinnedToBottom = false;
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = this.lastMaxOffset;
      this.pinnedToBottom = true;
    }
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }
}

export class WorkDiffComponent {
  private offset = 0;
  private pageSize = 1;
  private maxOffset = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  constructor(
    private readonly address: string,
    private readonly item: WorkItem,
    private readonly done: () => void,
    private readonly requestRender: () => void,
    private readonly theme: ExtensionContext["ui"]["theme"],
    private readonly viewportRows: number | (() => number),
  ) {}
  private rows(): number { return typeof this.viewportRows === "function" ? this.viewportRows() : this.viewportRows; }
  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const patch = sanitizeConversationBody(this.item.patchPreview ?? "(patch unavailable; reopen after the session result is persisted)");
    let rendered = this.cachedWidth === safeWidth ? this.cachedLines : undefined;
    if (!rendered) {
      let themedPatch: string;
      try { themedPatch = renderDiff(patch, { filePath: sanitizeConversationLabel(this.item.displayPath ?? "") }); }
      catch { themedPatch = patch; }
      rendered = themedPatch.split("\n").flatMap((line) => wrapTextWithAnsi(line, safeWidth));
      this.cachedWidth = safeWidth; this.cachedLines = rendered;
    }
    this.pageSize = Math.max(1, this.rows() - 5);
    this.maxOffset = Math.max(0, rendered.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maxOffset);
    const stats = this.item.linesAdded === undefined || this.item.linesRemoved === undefined ? "patch stats unknown" : `+${this.item.linesAdded}/-${this.item.linesRemoved}`;
    const truncated = this.item.patchTruncated
      ? (this.item.patchSource === "session" ? " · persisted patch capped at 50 KB/2,000 lines" : " · event preview truncated; close/reopen to retry session artifact")
      : "";
    return [
      this.theme.fg("accent", this.theme.bold(`Edit diff · ${sanitizeConversationLabel(this.address)}`)),
      this.theme.fg("dim", `${this.item.startedAt.slice(11, 19)} · ${sanitizeConversationLabel(this.item.displayPath ?? "unknown path")} · ${stats}${truncated}`),
      this.theme.fg("borderMuted", "─".repeat(Math.min(80, safeWidth))),
      ...rendered.slice(this.offset, this.offset + this.pageSize),
      this.theme.fg("dim", `lines ${this.offset + 1}-${Math.min(rendered.length, this.offset + this.pageSize)}/${rendered.length} · ↑↓ scroll · pgup/pgdn · home/end · d or esc close`),
    ].map((line) => truncateToWidth(line, safeWidth));
  }
  invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }
  handleInput(data: string): void {
    if (data === "d" || matchesKey(data, Key.escape)) { this.done(); return; }
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, Key.down)) this.offset = Math.min(this.maxOffset, this.offset + 1);
    else if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - this.pageSize);
    else if (matchesKey(data, Key.pageDown)) this.offset = Math.min(this.maxOffset, this.offset + this.pageSize);
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = this.maxOffset;
    this.requestRender();
  }
}

export class DashboardComponent {
  private selected = 0;
  private detail = false;
  private tab: "work" | "activity" | "inbox" | "profile" = "work";
  private inboxReturn: "work" | "activity" | "profile" = "work";
  private workSelected = 0;
  private feedback?: string;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly getSnapshot: () => BrokerSnapshot,
    private readonly getInbox: (address: string) => ReturnType<AgentBroker["fetchUnanswered"]>,
    private readonly done: (action: DashboardAction) => void,
    private readonly requestRender: () => void,
    private readonly theme: ExtensionContext["ui"]["theme"],
    initialAddress?: string,
    private readonly isConversationKey: (data: string) => boolean = (data) => matchesKey(data, Key.ctrl("o")),
    private readonly viewportRows: number | (() => number) = 24,
    private readonly getInspection?: (address: string) => AgentInspection,
  ) {
    if (initialAddress) {
      const index = getSnapshot().agents.findIndex((agent) => agent.address === initialAddress);
      if (index >= 0) this.selected = index;
    }
    this.refreshTimer = setInterval(() => {
      if (this.getSnapshot().agents.some((agent) => (agent.work?.active.length ?? 0) > 0)) this.requestRender();
    }, 1_000);
    this.refreshTimer.unref?.();
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private visualWorkItems(agent: AgentRecord): WorkItem[] {
    const recent = [...(agent.work?.recent ?? [])].reverse();
    return [...(agent.work?.active ?? []), ...recent.filter((item) => item.attribution === "explicit"), ...recent.filter((item) => item.attribution === "unverified")];
  }

  private rows(): number { return typeof this.viewportRows === "function" ? this.viewportRows() : this.viewportRows; }

  private formatWorkLine(item: WorkItem, selected: boolean, conflicts: Map<string, string[]>): string {
    const marker = selected ? ">" : " ";
    const icon = item.status === "running" ? (item.attribution === "explicit" ? "✎" : "?") : item.status === "succeeded" ? (item.attribution === "explicit" ? "✓" : "?") : item.status === "failed" ? "✗" : "!";
    const target = sanitizeConversationLabel(item.displayPath ?? item.commandPreview ?? "(target unknown)");
    const toolName = sanitizeConversationLabel(item.toolName).slice(0, 100) || "tool";
    let outcome: string = item.status === "running" ? `running ${Math.max(0, Math.floor((Date.now() - Date.parse(item.startedAt)) / 1_000))}s` : item.status;
    if (item.status === "succeeded" && item.kind === "edit") outcome = item.linesAdded === undefined || item.linesRemoved === undefined ? "patch stats unknown" : `+${item.linesAdded}/-${item.linesRemoved}`;
    else if (item.status === "succeeded" && item.kind === "write") outcome = item.bytesWritten === undefined || item.linesWritten === undefined ? "size unknown" : `${item.bytesWritten} bytes · ${item.linesWritten} lines`;
    else if (item.status === "succeeded" && item.attribution === "unverified") outcome = "ok · file effects unknown";
    else if (item.status === "failed") outcome = `failed${item.error ? ` · ${item.error}` : ""}`;
    const warning = item.path && conflicts.has(item.path) ? ` · ⚠ concurrent explicit edit (${conflicts.get(item.path)!.length} agents)` : "";
    const line = `${marker} ${item.startedAt.slice(11, 19)} ${icon} ${toolName.padEnd(6)} ${target}  ${outcome}${warning}`;
    return this.theme.fg(item.status === "failed" ? "error" : warning ? "warning" : selected ? "accent" : "text", line);
  }

  render(width: number): string[] {
    const snapshot = this.getSnapshot();
    const agents = snapshot.agents;
    if (this.selected >= agents.length) this.selected = Math.max(0, agents.length - 1);
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold("Pi Email Subagents")));
    const mainAddress = sanitizeConversationLabel(snapshot.mainAddress);
    const conflicts = activePathConflicts(agents);
    const mainSummary = `main: ${mainAddress} · ${agents.length} agents · ${snapshot.unanswered} unanswered · ${snapshot.queuedMail} queued${conflicts.size ? ` · ⚠ ${conflicts.size} active path conflict${conflicts.size === 1 ? "" : "s"}` : ""}`;
    const full = snapshot.capacity.identitiesUsed >= snapshot.capacity.identitiesLimit;
    const identityCapacity = width < 28
      ? `identity ${snapshot.capacity.identitiesUsed}/${snapshot.capacity.identitiesLimit}${full ? " FULL" : ""}`
      : `identity capacity ${snapshot.capacity.identitiesUsed}/${snapshot.capacity.identitiesLimit}${full ? " FULL" : ""}`;
    const runCapacity = `run slots ${snapshot.capacity.runSlotsUsed}/${snapshot.capacity.runSlotsLimit}`;
    if (width < 48) {
      lines.push(this.theme.fg(full ? "warning" : "dim", identityCapacity));
      lines.push(this.theme.fg("dim", runCapacity));
      lines.push(this.theme.fg("dim", mainSummary));
    } else {
      lines.push(this.theme.fg(full ? "warning" : "dim", `${identityCapacity} · ${runCapacity} · ${mainSummary}`));
    }
    if (full) lines.push(this.theme.fg("warning", "FULL: reuse/restart relevant work; stop retains its lease; archive only a clean identity."));
    lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(1, Math.min(width, 80)))));

    if (agents.length === 0) {
      lines.push(this.theme.fg("muted", "No subagents. send_email() to a valid unknown address to create one."));
    } else if (!this.detail) {
      const visibleAgents = Math.max(1, Math.floor((this.rows() - lines.length - 2) / 3));
      const agentStart = Math.max(0, Math.min(this.selected - Math.floor(visibleAgents / 2), agents.length - visibleAgents));
      for (let index = agentStart; index < Math.min(agents.length, agentStart + visibleAgents); index += 1) {
        const agent = agents[index]!;
        const selected = index === this.selected;
        const color = agent.state === "failed" ? "error" : agent.state === "running" ? "success" : selected ? "accent" : "text";
        const prefix = selected ? ">" : " ";
        const usage = `${formatTokens(agent.usage.input)}↑ ${formatTokens(agent.usage.output)}↓ ctx:${formatTokens(agent.usage.contextTokens)} $${agent.usage.cost.toFixed(4)}`;
        const address = sanitizeConversationLabel(agent.address);
        const modelId = sanitizeConversationLabel(agent.modelId);
        lines.push(this.theme.fg(color, `${prefix} ${statusIcon(agent.state)} ${address}`));
        const quarantine = agent.cleanup ? " · cleanup unknown · capacity held" : "";
        lines.push(this.theme.fg("dim", `    ${displayStatus(agent.state)} · ${modelId} · effort ${agent.effort} · ${usage}${quarantine}`));
        const work = agent.work;
        const active = [...(work?.active ?? [])].sort((a, b) => (a.attribution === "explicit" ? -1 : 1) - (b.attribution === "explicit" ? -1 : 1));
        const now = active[0];
        const aggregate = work ? aggregateWork(work) : { files: 0, linesAdded: 0, linesRemoved: 0, writes: 0, unverified: 0, statsUnknown: false };
        const elapsed = now ? Math.max(0, Math.floor((Date.now() - Date.parse(now.startedAt)) / 1_000)) : 0;
        const nowText = now ? `${now.status === "running" ? (now.kind === "edit" ? "editing" : now.kind === "write" ? "writing" : `${now.toolName} (unverified effects)`) : now.toolName} ${now.displayPath ?? now.commandPreview ?? ""} (${elapsed}s)${active.length > 1 ? ` +${active.length - 1} more` : ""}` : safeActivitySummary(agent.currentActivity ?? "idle");
        const aggregateText = aggregate.files || aggregate.unverified
          ? ` · run: ${aggregate.files} files${aggregate.statsUnknown ? " · patch stats unknown" : ` +${aggregate.linesAdded}/-${aggregate.linesRemoved}`}${aggregate.writes ? ` · ${aggregate.writes} writes` : ""}${aggregate.unverified ? ` · ${aggregate.unverified} unverified attempts` : ""}`
          : "";
        const anyConflict = active.find((item) => item.path && conflicts.has(item.path));
        const participants = anyConflict?.path ? conflicts.get(anyConflict.path) : undefined;
        lines.push(this.theme.fg(participants ? "warning" : "muted", `    now: ${truncateText(sanitizeConversationLabel(nowText), 100)}${aggregateText}${participants ? ` · ⚠ concurrent explicit edit (${participants.length} agents)` : ""}`));
      }
    } else {
      const agent = agents[this.selected];
      if (agent) {
        const address = sanitizeConversationLabel(agent.address);
        const provider = sanitizeConversationLabel(agent.provider);
        const modelId = sanitizeConversationLabel(agent.modelId);
        lines.push(this.theme.fg("accent", `${statusIcon(agent.state)} ${address}`));
        const writable = agent.tools.some((tool) => tool === "edit" || tool === "write" || tool === "bash");
        lines.push(this.theme.fg("muted", `${displayStatus(agent.state)} · ${provider}/${modelId} · effort ${agent.effort} · ${writable ? "writable" : "read-only"}`));
        lines.push(this.theme.fg("dim", `[${this.tab === "work" ? "Work" : "work"}] [${this.tab === "activity" ? "Activity" : "activity"}] [${this.tab === "inbox" ? "Inbox" : "inbox"}] [${this.tab === "profile" ? "Profile/Lifecycle" : "profile/lifecycle"}]`));
        // Keep deadline disclosure visible in every detail tab; Profile adds tools/failure context.
        lines.push(this.theme.fg("dim", `lifecycle: spawn ${agent.lifecycle.spawnTimeoutMs}ms · prompt ${agent.lifecycle.promptAcceptanceTimeoutMs}ms · run ${agent.lifecycle.runTimeoutMs}ms · idle ${agent.lifecycle.idleTimeoutMs}ms · abort ${agent.lifecycle.abortTimeoutMs}ms · dispose ${agent.lifecycle.disposeTimeoutMs}ms`));
        if (agent.cleanup) {
          lines.push(this.theme.fg("error", `cleanup ${agent.cleanup.state}: quiescence unknown · capacity held · restart/archive blocked`));
        }
        lines.push("");
        if (this.tab === "work") {
          const active = agent.work?.active ?? [];
          const recent = [...(agent.work?.recent ?? [])].reverse();
          const items = this.visualWorkItems(agent);
          this.workSelected = Math.min(this.workSelected, Math.max(0, items.length - 1));
          const maxWorkRows = Math.max(1, this.rows() - 13);
          const workStart = Math.max(0, Math.min(this.workSelected - Math.floor(maxWorkRows / 2), items.length - maxWorkRows));
          const visibleIds = new Set(items.slice(workStart, workStart + maxWorkRows).map((item) => item.toolCallId));
          const visibleActive = active.filter((item) => visibleIds.has(item.toolCallId));
          if (visibleActive.length) lines.push(this.theme.fg("toolTitle", "Now"));
          for (const item of visibleActive) lines.push(this.formatWorkLine(item, items.indexOf(item) === this.workSelected, conflicts));
          const mutations = recent.filter((item) => item.attribution === "explicit");
          const visibleMutations = mutations.filter((item) => visibleIds.has(item.toolCallId));
          if (visibleMutations.length) lines.push(this.theme.fg("toolTitle", "Confirmed and attempted mutations"));
          for (const item of visibleMutations) {
            const index = items.indexOf(item);
            lines.push(this.formatWorkLine(item, index === this.workSelected, conflicts));
          }
          const unverified = recent.filter((item) => item.attribution === "unverified");
          const visibleUnverified = unverified.filter((item) => visibleIds.has(item.toolCallId));
          if (visibleUnverified.length) lines.push(this.theme.fg("toolTitle", "Unverified effects"));
          for (const item of visibleUnverified) {
            const index = items.indexOf(item);
            lines.push(this.formatWorkLine(item, index === this.workSelected, conflicts));
          }
          const inspection = agent.work?.inspection ?? { reads: 0, searches: 0, listings: 0 };
          lines.push(this.theme.fg("dim", `Inspection this run: ${inspection.reads} reads · ${inspection.searches} searches · ${inspection.listings} listings`));
          if (agent.work?.recoveryError) lines.push(this.theme.fg("warning", `recovery diagnostic: ${sanitizeConversationLabel(agent.work.recoveryError)}`));
        } else if (this.tab === "activity") {
          lines.push(this.theme.fg("toolTitle", "Recent activity"));
          for (const item of agent.activity.slice(-15)) {
            const color = item.kind === "error" ? "error" : item.kind === "tool" ? "accent" : "muted";
            lines.push(this.theme.fg(color, `${item.at.slice(11, 19)} ${item.kind.padEnd(6)} ${safeActivitySummary(item.summary)}`));
          }
          if (agent.activity.length === 0) lines.push(this.theme.fg("muted", "(none)"));
        } else if (this.tab === "inbox") {
          const emails = this.getInbox(agent.address);
          lines.push(this.theme.fg("toolTitle", `Unanswered email (${emails.length})`));
          if (emails.length === 0) lines.push(this.theme.fg("muted", "(none)"));
          for (const email of emails) {
            lines.push(this.theme.fg(email.priority === "high" ? "warning" : "accent", `[${email.priority.toUpperCase()}] ${sanitizeConversationLabel(email.subject)}`));
            lines.push(this.theme.fg("dim", `${sanitizeConversationLabel(email.id)} · from ${sanitizeConversationLabel(email.from)}`));
            const excerpt = sanitizeConversationBody(email.message).slice(0, 500);
            for (const excerptLine of wrapTextWithAnsi(this.theme.fg("text", excerpt), Math.max(1, width - 2)).slice(0, 3)) lines.push(`  ${excerptLine}`);
          }
        } else {
          lines.push(this.theme.fg("dim", `tools: ${agent.tools.map(sanitizeConversationLabel).join(", ")}`));
          lines.push(this.theme.fg("dim", `internal state: ${agent.state}`));
          let inspection: AgentInspection | undefined;
          try { inspection = this.getInspection?.(agent.address); } catch { /* current snapshot remains renderable */ }
          if (inspection) {
            lines.push(this.theme.fg("dim", `activation lease: ${inspection.holdsActivationLease ? "held" : "free"}`));
            lines.push(this.theme.fg("dim", `identity capacity: ${inspection.capacity.identitiesUsed}/${inspection.capacity.identitiesLimit} · run slots: ${inspection.capacity.runSlotsUsed}/${inspection.capacity.runSlotsLimit}`));
            lines.push(this.theme.fg("dim", `obligations: ${inspection.unanswered} incoming unanswered · ${inspection.outgoingUnanswered} outgoing unanswered · ${inspection.archiveBlockers.queued.count} queued · ${inspection.archiveBlockers.pendingReplies.count} reply delivery pending`));
            lines.push(this.theme.fg(inspection.archiveEligible ? "success" : "warning", `archive eligible: ${inspection.archiveEligible ? "yes" : "no"}`));
            const obligations = inspection.archiveBlockers.queued.count
              + inspection.archiveBlockers.incomingUnanswered.count
              + inspection.archiveBlockers.outgoingUnanswered.count
              + inspection.archiveBlockers.pendingReplies.count;
            const recovery = inspection.cleanup
              ? "wait for cleanup proof; capacity stays held"
              : (inspection.state === "stopped" || inspection.state === "failed") && obligations > 0
                ? "restart real obligations; cancel only an explicitly abandoned exact request; then archive when clean"
                : inspection.archiveEligible && inspection.holdsActivationLease
                  ? "reuse if relevant, or archive this clean identity; stop alone does not free its lease"
                  : inspection.state === "archived" || !inspection.holdsActivationLease
                    ? "free identity capacity is required before restart/restoration"
                    : "reuse this identity and finish real obligations before archival";
            lines.push(this.theme.fg("warning", `recovery: ${recovery}`));
          }
          if (agent.failure) {
            lines.push(this.theme.fg("error", `failure: ${sanitizeConversationLabel(agent.failure)}`));
            if (inspection && agent.activity.some((item) => item.summary === "Agent run failed")) {
              const obligation = inspection.unanswered === 0
                ? "No delivered requests remain unanswered."
                : `${inspection.unanswered} delivered request${inspection.unanswered === 1 ? "" : "s"} remain${inspection.unanswered === 1 ? "s" : ""} unanswered.`;
              lines.push(this.theme.fg("warning", `Terminal worker run failure · ${provider}/${modelId}`));
              lines.push(this.theme.fg("warning", "Provider/network cause may be external or unclear."));
              lines.push(this.theme.fg("warning", obligation));
              if (currentBatchHasEffectfulWork(agent.work)) {
                lines.push(this.theme.fg("warning", "Current batch includes mutation/shell/custom work; effects may exist."));
                lines.push(this.theme.fg("warning", "Inspect Work and Conversation before explicit same-identity restart."));
              } else {
                lines.push(this.theme.fg("warning", "No mutation/shell/custom effect is recorded in the current work ledger; this is not proof of pre-tool failure."));
                lines.push(this.theme.fg("warning", "Inspect Conversation before explicit same-identity restart."));
              }
            }
          }
        }
      }
    }

    if (this.feedback) lines.push(this.theme.fg("warning", this.feedback));
    lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(1, Math.min(width, 80)))));
    const help = this.detail
      ? (this.tab === "work" ? "↑↓ select work · d diff · tab tabs · i inbox/back · ctrl+o conversation · e email · k stop · r restart · a archive · x clear · m effort · esc back" : "tab tabs · i inbox/back · ctrl+o conversation · e email · k stop · r restart · a archive · x clear · m effort · esc back")
      : "↑↓ select · enter detail · ctrl+o conversation · i inbox · e email · k stop · r restart · a archive · x clear · m effort · esc close";
    lines.push(this.theme.fg("dim", help));
    const rowLimit = Math.max(6, this.rows());
    const bounded = lines.length <= rowLimit ? lines : [...lines.slice(0, rowLimit - 2), this.theme.fg("dim", "… more rows hidden; navigate to inspect …"), lines.at(-1)!];
    return bounded.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const snapshot = this.getSnapshot();
    const agents = snapshot.agents;
    if (this.isConversationKey(data) && agents[this.selected]) {
      this.done({ kind: "conversation", address: agents[this.selected]!.address });
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.detail) {
        this.detail = false;
        this.tab = "work";
        this.requestRender();
      } else this.done({ kind: "close" });
      return;
    }
    const agent = agents[this.selected];
    const workItems = agent ? this.visualWorkItems(agent) : [];
    if (this.detail && this.tab === "work" && matchesKey(data, Key.up) && workItems.length > 0) this.workSelected = (this.workSelected - 1 + workItems.length) % workItems.length;
    else if (this.detail && this.tab === "work" && matchesKey(data, Key.down) && workItems.length > 0) this.workSelected = (this.workSelected + 1) % workItems.length;
    else if (!this.detail && matchesKey(data, Key.up) && agents.length > 0) this.selected = (this.selected - 1 + agents.length) % agents.length;
    else if (!this.detail && matchesKey(data, Key.down) && agents.length > 0) this.selected = (this.selected + 1) % agents.length;
    else if (matchesKey(data, Key.enter) && agents.length > 0) {
      this.detail = true;
      this.tab = "work";
    } else if (matchesKey(data, Key.tab) && this.detail) {
      const tabs = ["work", "activity", "inbox", "profile"] as const;
      this.tab = tabs[(tabs.indexOf(this.tab) + 1) % tabs.length]!;
    } else if (data === "i" && agents.length > 0) {
      this.detail = true;
      if (this.tab === "inbox") this.tab = this.inboxReturn;
      else { this.inboxReturn = this.tab; this.tab = "inbox"; }
    } else if (data === "d" && this.detail && this.tab === "work") {
      const item = workItems[this.workSelected];
      if (item?.kind === "edit" && item.status === "succeeded" && (item.patchPreview || item.patchAvailable)) this.done({ kind: "diff", address: agent!.address, workItem: item });
      else this.feedback = "No diff is available for the selected item.";
    } else if (data === "e") this.done({ kind: "compose", address: agents[this.selected]?.address });
    else if (data === "k" && agents[this.selected]) this.done({ kind: "stop", address: agents[this.selected]!.address });
    else if (data === "r" && agents[this.selected]) this.done({ kind: "restart", address: agents[this.selected]!.address });
    else if (data === "a" && agents[this.selected]) this.done({ kind: "archive", address: agents[this.selected]!.address });
    else if (data === "x" && agents[this.selected]) this.done({ kind: "clear_failure", address: agents[this.selected]!.address });
    else if (data === "m" && agents[this.selected]) this.done({ kind: "effort", address: agents[this.selected]!.address });
    this.requestRender();
  }
}

export class UIController {
  private snapshot?: BrokerSnapshot;
  private ctx?: ExtensionContext;
  private requestDashboardRender?: () => void;

  bind(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.renderStatus();
  }

  clear(): void {
    try {
      this.ctx?.ui.setWidget("pi-email-subagent", undefined);
      this.ctx?.ui.setStatus("pi-email-subagent", undefined);
    } catch { /* context may already be stale */ }
    this.ctx = undefined;
    this.snapshot = undefined;
    this.requestDashboardRender = undefined;
  }

  update(snapshot: BrokerSnapshot): void {
    this.snapshot = snapshot;
    this.renderStatus();
    this.requestDashboardRender?.();
  }

  private renderStatus(): void {
    if (!this.ctx || !this.snapshot) return;
    try {
      const agents = this.snapshot.agents;
      const running = agents.filter((agent) => agent.state === "running").length;
      const queued = agents.filter((agent) => agent.state === "queued").length;
      const idle = agents.filter((agent) => agent.state === "idle").length;
      const failed = agents.filter((agent) => agent.state === "failed").length;
      const spawning = agents.filter((agent) => agent.state === "spawning").length;
      const cleanupUnknown = agents.filter((agent) => Boolean(agent.cleanup)).length;
      const closed = agents.filter((agent) => CLOSED_STATES.has(agent.state)).length;
      const activeMutations = agents.flatMap((agent) => (agent.work?.active ?? []).filter((item) => item.attribution === "explicit").map((item) => sanitizeConversationLabel(`${agent.name}: ${item.kind} ${item.displayPath ?? "unknown"}`)));
      const conflicts = activePathConflicts(agents);
      const work = activeMutations.length ? ` · now ${activeMutations.slice(0, 2).join("; ")}${activeMutations.length > 2 ? ` +${activeMutations.length - 2}` : ""}` : "";
      const warning = conflicts.size ? ` · ⚠ ${conflicts.size} path conflict${conflicts.size === 1 ? "" : "s"}` : "";
      const capacity = ` · identity capacity ${this.snapshot.capacity.identitiesUsed}/${this.snapshot.capacity.identitiesLimit}${this.snapshot.capacity.identitiesUsed >= this.snapshot.capacity.identitiesLimit ? " FULL" : ""} · run slots ${this.snapshot.capacity.runSlotsUsed}/${this.snapshot.capacity.runSlotsLimit}`;
      const line = truncateText(`Agents: ${running} running · ${queued} queued · ${idle} idle · ${this.snapshot.unanswered} unanswered${spawning ? ` · ${spawning} spawning` : ""}${failed ? ` · ${failed} failed` : ""}${cleanupUnknown ? ` · ${cleanupUnknown} cleanup unknown` : ""}${closed ? ` · ${closed} closed` : ""}${capacity}${work}${warning}`, 240);
      // The below-editor widget is the canonical agents bar. Clear the legacy
      // footer status instead of rendering a redundant, unaligned `agents:0/1`.
      this.ctx.ui.setStatus("pi-email-subagent", undefined);
      if (agents.length > 0 || this.snapshot.unanswered > 0 || this.snapshot.queuedMail > 0) {
        this.ctx.ui.setWidget("pi-email-subagent", [line], { placement: "belowEditor" });
      } else {
        this.ctx.ui.setWidget("pi-email-subagent", undefined);
      }
    } catch { /* context may have been replaced */ }
  }

  async showDashboard(ctx: ExtensionContext, broker: AgentBroker, initialAddress?: string): Promise<void> {
    let initial = initialAddress;
    while (true) {
      const action = await ctx.ui.custom<DashboardAction>((tui, theme, keybindings, done) => {
        this.requestDashboardRender = () => tui.requestRender();
        return new DashboardComponent(
          () => broker.getSnapshot(),
          (address) => broker.fetchUnanswered(address),
          done,
          () => tui.requestRender(),
          theme,
          initial,
          (data) => keybindings.matches(data, "app.tools.expand") || matchesKey(data, Key.ctrl("o")),
          () => Math.max(8, tui.terminal.rows - 2),
          (address) => broker.inspectAgent(address),
        );
      });
      this.requestDashboardRender = undefined;
      initial = action.address;
      if (action.kind === "close") return;
      try {
        if (action.kind === "compose") await this.compose(ctx, broker, action.address);
        else if (action.kind === "conversation" && action.address) await this.showConversation(ctx, broker, action.address);
        else if (action.kind === "diff" && action.address && action.workItem) await this.showDiff(ctx, broker, action.address, action.workItem);
        else if (action.kind === "stop" && action.address) await broker.stop(action.address);
        else if (action.kind === "restart" && action.address) await broker.restart(action.address);
        else if (action.kind === "archive" && action.address) await broker.archive(action.address);
        else if (action.kind === "clear_failure" && action.address) await broker.clearFailure(action.address);
        else if (action.kind === "effort" && action.address) await this.changeEffort(ctx, broker, action.address);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    }
  }

  private async showDiff(ctx: ExtensionContext, broker: AgentBroker, address: string, item: WorkItem): Promise<void> {
    let displayItem = broker.getWorkItem(address, item.toolCallId) ?? item;
    const sessionFile = broker.getSnapshot().agents.find((agent) => agent.address === address)?.sessionFile;
    if (sessionFile) {
      try {
        const persisted = await readPersistedEditPatch(sessionFile, item.toolCallId);
        if (persisted) displayItem = { ...item, patchPreview: persisted.patch, patchTruncated: persisted.truncated, patchSource: "session" };
      } catch { /* the event/registry preview remains usable while JSONL is being appended */ }
    }
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new WorkDiffComponent(
      address, displayItem, done, () => tui.requestRender(), theme, () => Math.max(6, tui.terminal.rows - 2),
    ));
  }

  private async showConversation(ctx: ExtensionContext, broker: AgentBroker, address: string): Promise<void> {
    const record = broker.getSnapshot().agents.find((agent) => agent.address === address);
    if (!record) throw new Error(`Unknown agent ${address}.`);
    if (!record.sessionFile) throw new Error(`${address} does not have a recorded session yet.`);
    const source = new ConversationSource(record.sessionFile);
    await source.refresh(true);
    if (source.error && source.blocks.length === 0) throw new Error(`Could not read ${address} conversation: ${source.error}`);
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => new ConversationComponent(
      address,
      source,
      done,
      () => tui.requestRender(),
      theme,
      Math.max(4, tui.terminal.rows - 6),
      (data) => keybindings.matches(data, "app.tools.expand") || matchesKey(data, Key.ctrl("o")),
    ));
  }

  private async compose(ctx: ExtensionContext, broker: AgentBroker, suggested?: string): Promise<void> {
    const to = await ctx.ui.input("Recipient", suggested ?? "name.task-slug@model.com");
    if (!to) return;
    const subject = await ctx.ui.input("Subject", "Self-contained task or question");
    if (!subject) return;
    const message = await ctx.ui.editor("Email message");
    if (!message) return;
    const selectedPriority = await ctx.ui.select("Priority", ["low", "high"]);
    if (!selectedPriority) return;
    const input: SendEmailInput = { to, subject, message, priority: selectedPriority as "low" | "high" };
    const result = await broker.send(broker.mainAddress, input);
    ctx.ui.notify(`Email ${result.envelope.id} accepted${result.spawned ? "; recipient spawned" : ""}.`, "info");
  }

  private async changeEffort(ctx: ExtensionContext, broker: AgentBroker, address: string): Promise<void> {
    const value = await ctx.ui.select("Agent effort", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    if (!value || !isThinkingLevel(value)) return;
    await broker.setEffort(address, value as ThinkingLevel);
    ctx.ui.notify(`${address} effort set to ${value}.`, "info");
  }
}
