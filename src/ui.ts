import { readFile, stat } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { migrateSessionEntries, parseSessionEntries, type ExtensionContext, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentBroker } from "./broker.ts";
import { isThinkingLevel } from "./config.ts";
import type { AgentRecord, BrokerSnapshot, SendEmailInput } from "./types.ts";
import { errorMessage, truncateText } from "./util.ts";

interface DashboardAction {
  kind: "close" | "compose" | "conversation" | "stop" | "restart" | "archive" | "clear_failure" | "effort";
  address?: string;
}

function statusIcon(state: AgentRecord["state"]): string {
  switch (state) {
    case "running": return "●";
    case "queued": return "◷";
    case "idle": return "○";
    case "failed": return "✗";
    case "stopped": return "■";
    case "paused": return "Ⅱ";
    case "spawning": return "◌";
    case "archived": return "◇";
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
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

export function sanitizeConversationBody(value: string): string {
  return stripTerminalSequences(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "  ");
}

export function sanitizeConversationLabel(value: string): string {
  return sanitizeConversationBody(value).replace(/\s+/g, " ").trim();
}

function stringify(value: unknown): string {
  if (value === undefined) return "{}";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
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
      parts.push(`→ ${String(block.name ?? "tool")}\n${stringify(block.arguments)}`);
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
        blocks.push({
          at,
          role: failed ? "error" : "tool",
          label: sanitizeConversationLabel(`Tool result · ${String(message.toolName ?? "tool")}`),
          body: sanitizeConversationBody(body || "(empty result)"),
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

export class DashboardComponent {
  private selected = 0;
  private detail = false;
  private inbox = false;

  constructor(
    private readonly getSnapshot: () => BrokerSnapshot,
    private readonly getInbox: (address: string) => ReturnType<AgentBroker["fetchUnanswered"]>,
    private readonly done: (action: DashboardAction) => void,
    private readonly requestRender: () => void,
    private readonly theme: ExtensionContext["ui"]["theme"],
    initialAddress?: string,
    private readonly isConversationKey: (data: string) => boolean = (data) => matchesKey(data, Key.ctrl("o")),
  ) {
    if (initialAddress) {
      const index = getSnapshot().agents.findIndex((agent) => agent.address === initialAddress);
      if (index >= 0) this.selected = index;
    }
  }

  render(width: number): string[] {
    const snapshot = this.getSnapshot();
    const agents = snapshot.agents;
    if (this.selected >= agents.length) this.selected = Math.max(0, agents.length - 1);
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold("Pi Email Subagents")));
    const mainAddress = sanitizeConversationLabel(snapshot.mainAddress);
    lines.push(this.theme.fg("dim", `main: ${mainAddress} · ${agents.length} agents · ${snapshot.unanswered} unanswered · ${snapshot.queuedMail} queued`));
    lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(1, Math.min(width, 80)))));

    if (agents.length === 0) {
      lines.push(this.theme.fg("muted", "No subagents. send_email() to a valid unknown address to create one."));
    } else if (!this.detail && !this.inbox) {
      for (let index = 0; index < agents.length; index += 1) {
        const agent = agents[index]!;
        const selected = index === this.selected;
        const color = agent.state === "failed" ? "error" : agent.state === "running" ? "success" : selected ? "accent" : "text";
        const prefix = selected ? ">" : " ";
        const usage = `${formatTokens(agent.usage.input)}↑ ${formatTokens(agent.usage.output)}↓ ctx:${formatTokens(agent.usage.contextTokens)} $${agent.usage.cost.toFixed(4)}`;
        const address = sanitizeConversationLabel(agent.address);
        const modelId = sanitizeConversationLabel(agent.modelId);
        lines.push(this.theme.fg(color, `${prefix} ${statusIcon(agent.state)} ${address}`));
        lines.push(this.theme.fg("dim", `    ${agent.state} · ${modelId} · effort ${agent.effort} · ${usage}`));
        if (agent.currentActivity) {
          lines.push(this.theme.fg("muted", `    ${truncateText(sanitizeConversationLabel(agent.currentActivity), 120)}`));
        }
      }
    } else {
      const agent = agents[this.selected];
      if (agent) {
        const address = sanitizeConversationLabel(agent.address);
        const provider = sanitizeConversationLabel(agent.provider);
        const modelId = sanitizeConversationLabel(agent.modelId);
        lines.push(this.theme.fg("accent", `${statusIcon(agent.state)} ${address}`));
        lines.push(this.theme.fg("muted", `${agent.state} · ${provider}/${modelId} · effort ${agent.effort}`));
        lines.push(this.theme.fg("dim", `tools: ${agent.tools.map(sanitizeConversationLabel).join(", ")}`));
        if (agent.failure) lines.push(this.theme.fg("error", `failure: ${sanitizeConversationLabel(agent.failure)}`));
        lines.push("");
        if (this.inbox) {
          const emails = this.getInbox(agent.address);
          lines.push(this.theme.fg("toolTitle", `Unanswered email (${emails.length})`));
          if (emails.length === 0) lines.push(this.theme.fg("muted", "(none)"));
          for (const email of emails) {
            const subject = sanitizeConversationLabel(email.subject);
            const id = sanitizeConversationLabel(email.id);
            const from = sanitizeConversationLabel(email.from);
            const body = sanitizeConversationLabel(email.message);
            lines.push(this.theme.fg(email.priority === "high" ? "warning" : "accent", `[${email.priority.toUpperCase()}] ${subject}`));
            lines.push(this.theme.fg("dim", `${id} · from ${from}`));
            lines.push(this.theme.fg("text", truncateText(body, 180)));
          }
        } else {
          lines.push(this.theme.fg("toolTitle", "Recent activity"));
          const activity = agent.activity.slice(-15);
          if (activity.length === 0) lines.push(this.theme.fg("muted", "(none)"));
          for (const item of activity) {
            const time = item.at.slice(11, 19);
            const color = item.kind === "error" ? "error" : item.kind === "tool" ? "accent" : "muted";
            const summary = truncateText(sanitizeConversationLabel(item.summary), 180);
            lines.push(this.theme.fg(color, `${time} ${item.kind.padEnd(6)} ${summary}`));
          }
        }
      }
    }

    lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(1, Math.min(width, 80)))));
    lines.push(this.theme.fg("dim", "↑↓ select · enter detail · ctrl+o conversation · i inbox · e email · k stop · r restart · a archive · x clear failure · m effort · esc close/back"));
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
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
      if (this.detail || this.inbox) {
        this.detail = false;
        this.inbox = false;
        this.requestRender();
      } else this.done({ kind: "close" });
      return;
    }
    if (matchesKey(data, Key.up) && agents.length > 0) this.selected = (this.selected - 1 + agents.length) % agents.length;
    else if (matchesKey(data, Key.down) && agents.length > 0) this.selected = (this.selected + 1) % agents.length;
    else if (matchesKey(data, Key.enter) && agents.length > 0) {
      this.detail = !this.detail;
      this.inbox = false;
    } else if (data === "i" && agents.length > 0) {
      this.inbox = !this.inbox;
      this.detail = false;
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
      const other = agents.length - running - queued - idle - failed;
      const line = `Agents: ${running} running · ${queued} queued · ${idle} idle · ${this.snapshot.unanswered} unanswered${failed ? ` · ${failed} failed` : ""}${other ? ` · ${other} paused/stopped/archived` : ""}`;
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
        );
      });
      this.requestDashboardRender = undefined;
      initial = action.address;
      if (action.kind === "close") return;
      try {
        if (action.kind === "compose") await this.compose(ctx, broker, action.address);
        else if (action.kind === "conversation" && action.address) await this.showConversation(ctx, broker, action.address);
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
