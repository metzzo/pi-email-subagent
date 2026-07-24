import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentBroker } from "./broker.ts";
import { isThinkingLevel } from "./config.ts";
import type { AgentRecord, BrokerSnapshot, SendEmailInput } from "./types.ts";
import { errorMessage, truncateText } from "./util.ts";

interface DashboardAction {
  kind: "close" | "compose" | "stop" | "restart" | "archive" | "clear_failure" | "effort";
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
    lines.push(this.theme.fg("dim", `main: ${snapshot.mainAddress} · ${agents.length} agents · ${snapshot.unanswered} unanswered · ${snapshot.queuedMail} queued`));
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
        lines.push(this.theme.fg(color, `${prefix} ${statusIcon(agent.state)} ${agent.address}`));
        lines.push(this.theme.fg("dim", `    ${agent.state} · ${agent.modelId} · effort ${agent.effort} · ${usage}`));
        if (agent.currentActivity) lines.push(this.theme.fg("muted", `    ${truncateText(agent.currentActivity, 120)}`));
      }
    } else {
      const agent = agents[this.selected];
      if (agent) {
        lines.push(this.theme.fg("accent", `${statusIcon(agent.state)} ${agent.address}`));
        lines.push(this.theme.fg("muted", `${agent.state} · ${agent.provider}/${agent.modelId} · effort ${agent.effort}`));
        lines.push(this.theme.fg("dim", `tools: ${agent.tools.join(", ")}`));
        if (agent.failure) lines.push(this.theme.fg("error", `failure: ${agent.failure}`));
        lines.push("");
        if (this.inbox) {
          const emails = this.getInbox(agent.address);
          lines.push(this.theme.fg("toolTitle", `Unanswered email (${emails.length})`));
          if (emails.length === 0) lines.push(this.theme.fg("muted", "(none)"));
          for (const email of emails) {
            lines.push(this.theme.fg(email.priority === "high" ? "warning" : "accent", `[${email.priority.toUpperCase()}] ${email.subject}`));
            lines.push(this.theme.fg("dim", `${email.id} · from ${email.from}`));
            lines.push(this.theme.fg("text", truncateText(email.message.replace(/\s+/g, " "), 180)));
          }
        } else {
          lines.push(this.theme.fg("toolTitle", "Recent activity"));
          const activity = agent.activity.slice(-15);
          if (activity.length === 0) lines.push(this.theme.fg("muted", "(none)"));
          for (const item of activity) {
            const time = item.at.slice(11, 19);
            const color = item.kind === "error" ? "error" : item.kind === "tool" ? "accent" : "muted";
            lines.push(this.theme.fg(color, `${time} ${item.kind.padEnd(6)} ${truncateText(item.summary, 180)}`));
          }
        }
      }
    }

    lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(1, Math.min(width, 80)))));
    lines.push(this.theme.fg("dim", "↑↓ select · enter detail · i inbox · e email · k stop · r restart · a archive · x clear failure · m effort · esc close/back"));
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const snapshot = this.getSnapshot();
    const agents = snapshot.agents;
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
      if (agents.length > 0 || this.snapshot.unanswered > 0 || this.snapshot.queuedMail > 0) {
        this.ctx.ui.setWidget("pi-email-subagent", [line], { placement: "belowEditor" });
        this.ctx.ui.setStatus("pi-email-subagent", `agents:${running}/${agents.length}`);
      } else {
        this.ctx.ui.setWidget("pi-email-subagent", undefined);
        this.ctx.ui.setStatus("pi-email-subagent", undefined);
      }
    } catch { /* context may have been replaced */ }
  }

  async showDashboard(ctx: ExtensionContext, broker: AgentBroker, initialAddress?: string): Promise<void> {
    let initial = initialAddress;
    while (true) {
      const action = await ctx.ui.custom<DashboardAction>((tui, theme, _keybindings, done) => {
        this.requestDashboardRender = () => tui.requestRender();
        return new DashboardComponent(
          () => broker.getSnapshot(),
          (address) => broker.fetchUnanswered(address),
          done,
          () => tui.requestRender(),
          theme,
          initial,
        );
      });
      this.requestDashboardRender = undefined;
      initial = action.address;
      if (action.kind === "close") return;
      try {
        if (action.kind === "compose") await this.compose(ctx, broker, action.address);
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
