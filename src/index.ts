import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Key, Text } from "@earendil-works/pi-tui";
import { makeMainAddress } from "./address.ts";
import { AgentBroker } from "./broker.ts";
import { isThinkingLevel, loadConfig } from "./config.ts";
import { createMainCoordinationTools } from "./main-tools.ts";
import { WorkerRuntimeFactory } from "./model-runtime.ts";
import { formatAlert, mainCoordinatorPrompt } from "./prompts.ts";
import { createWorkerMailTools, type FetchToolDetails, type SendToolDetails, SdkWorker } from "./sdk-worker.ts";
import type { BrokerSnapshot, EmailEnvelope, MainAdapter, SubagentConfig } from "./types.ts";
import {
  ConversationSource,
  formatConversationPreview,
  HISTORY_PREVIEW_MAX_BLOCKS,
  sanitizeConversationBody,
  sanitizeConversationLabel,
  UIController,
} from "./ui.ts";
import { errorMessage, truncateText } from "./util.ts";

const MESSAGE_TYPE = "pi-email-subagent.email";
const ALERT_TYPE = "pi-email-subagent.alert";

function availableModels(ctx: ExtensionContext): Model<any>[] {
  const models = [...ctx.modelRegistry.getAvailable()];
  if (ctx.model && !models.some((model) => model.provider === ctx.model!.provider && model.id === ctx.model!.id)) {
    models.push(ctx.model);
  }
  return models;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

export default function piEmailSubagentExtension(pi: ExtensionAPI): void {
  const ui = new UIController();
  let broker: AgentBroker | undefined;
  let mainAddress = "";
  let mainAliases = new Set<string>();
  let currentContext: ExtensionContext | undefined;
  let effectiveConfig: SubagentConfig | undefined;
  let latestBrokerSnapshot: BrokerSnapshot | undefined;
  let generation = 0;
  const conversationSources = new Map<string, ConversationSource>();

  const recordedConversationPreview = (address: string): string | undefined => {
    const source = conversationSources.get(address.toLowerCase());
    return source ? formatConversationPreview(source.blocks) : undefined;
  };

  const refreshConversationSources = async (snapshot: BrokerSnapshot, expectedGeneration: number): Promise<void> => {
    const retained = new Set<string>();
    const refreshes: Promise<boolean>[] = [];
    for (const record of snapshot.agents) {
      if (!record.sessionFile) continue;
      retained.add(record.address);
      let source = conversationSources.get(record.address);
      if (!source || source.sessionFile !== record.sessionFile) {
        source = new ConversationSource(record.sessionFile, 1_000, HISTORY_PREVIEW_MAX_BLOCKS);
        conversationSources.set(record.address, source);
      }
      refreshes.push(source.refresh());
    }
    for (const address of conversationSources.keys()) {
      if (!retained.has(address)) conversationSources.delete(address);
    }
    const changed = (await Promise.all(refreshes)).some(Boolean);
    if (changed && generation === expectedGeneration && latestBrokerSnapshot) ui.update(latestBrokerSnapshot);
  };

  const [sendTool, fetchTool] = createWorkerMailTools({
    sendEmail: async (input) => {
      if (!broker) throw new Error("Email broker is not ready.");
      return broker.send(broker.mainAddress, input);
    },
    fetchEmails: () => {
      if (!broker) throw new Error("Email broker is not ready.");
      return broker.fetchUnansweredBatch(broker.mainAddress);
    },
  });

  pi.registerTool({
    ...sendTool,
    renderCall(args: any, theme) {
      const priorityColor = args.priority === "high" ? "warning" : "accent";
      const priority = sanitizeConversationLabel(String(args.priority ?? "")).toUpperCase();
      const subject = truncateText(sanitizeConversationLabel(String(args.subject || "(no subject)")), 100);
      const recipient = sanitizeConversationLabel(String(args.to ?? ""));
      return new Text(
        `${theme.fg("toolTitle", theme.bold("send_email "))}${theme.fg(priorityColor, `[${priority}]`)} ${theme.fg("accent", recipient)}\n  ${theme.fg("dim", subject)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme, context) {
      const details = result.details as SendToolDetails | undefined;
      if (!details?.result) {
        return new Text(theme.fg(context.isError ? "error" : "toolOutput", sanitizeConversationBody(resultText(result))), 0, 0);
      }
      const sent = details.result;
      const icon = theme.fg("success", "✓");
      const recipient = sanitizeConversationLabel(sent.envelope.to);
      const envelopeId = sanitizeConversationLabel(sent.envelope.id);
      const disposition = sanitizeConversationLabel(sent.recipientDisposition);
      const model = sanitizeConversationLabel(
        sent.recipientProvider && sent.recipientModel
          ? `${sent.recipientProvider}/${sent.recipientModel}`
          : (sent.recipientModel ?? "main"),
      );
      const effort = sent.recipientEffort ? ` · effort ${sanitizeConversationLabel(sent.recipientEffort)}` : "";
      let text = `${icon} ${theme.fg("accent", recipient)} ${theme.fg("muted", envelopeId)}`;
      text += `\n${theme.fg("dim", `${disposition} · ${model}${effort}`)}`;
      if (sent.expectedReplySubject) text += `\n${theme.fg("muted", `reply: ${sanitizeConversationLabel(sent.expectedReplySubject)}`)}`;
      if (sent.answeredEmailId) text += `\n${theme.fg("success", `answered ${sanitizeConversationLabel(sent.answeredEmailId)}`)}`;
      if (expanded) {
        text += `\n\n${theme.fg("toolOutput", sanitizeConversationBody(sent.envelope.message))}`;
        const conversation = recordedConversationPreview(sent.envelope.to);
        if (conversation) {
          text += `\n\n${theme.fg("toolTitle", "Recent subagent conversation")}\n${theme.fg("toolOutput", conversation)}`;
        } else if (sent.envelope.to !== broker?.mainAddress) {
          text += `\n\n${theme.fg("dim", "Conversation preview is loading. Full transcript: /agents → select agent → Ctrl+O")}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  const [inspectAgentTool, waitForRepliesTool, cancelRequestTool, manageAgentTool] = createMainCoordinationTools(() => broker);

  pi.registerTool({
    ...fetchTool,
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("fetch_emails")), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as FetchToolDetails | undefined;
      if (!details) return new Text(theme.fg("toolOutput", sanitizeConversationBody(resultText(result))), 0, 0);
      if (details.emails.length === 0) return new Text(theme.fg("success", "✓ no unanswered emails"), 0, 0);
      const remainder = details.total > details.emails.length ? ` (showing ${details.emails.length} of ${details.total})` : "";
      let text = theme.fg("warning", `${details.emails.length} unanswered email${details.emails.length === 1 ? "" : "s"}${remainder}`);
      for (const email of details.emails) {
        const subject = sanitizeConversationLabel(email.subject);
        const from = sanitizeConversationLabel(email.from);
        text += `\n${theme.fg(email.priority === "high" ? "warning" : "accent", `[${email.priority.toUpperCase()}]`)} ${theme.fg("text", subject)} ${theme.fg("dim", `from ${from}`)}`;
        if (expanded) text += `\n  ${theme.fg("toolOutput", sanitizeConversationBody(email.message))}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool(inspectAgentTool);
  pi.registerTool(waitForRepliesTool);
  pi.registerTool(cancelRequestTool);
  pi.registerTool(manageAgentTool);

  pi.registerMessageRenderer<EmailEnvelope>(MESSAGE_TYPE, (message, { expanded }, theme) => {
    const email = message.details;
    if (!email) return new Text(String(message.content), 0, 0);
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const color = email.priority === "high" ? "warning" : "accent";
    const from = sanitizeConversationLabel(email.from);
    const to = sanitizeConversationLabel(email.to);
    const subject = sanitizeConversationLabel(email.subject);
    const body = sanitizeConversationBody(email.message);
    let text = `${theme.fg(color, "📬")} ${theme.fg("accent", from)} ${theme.fg("muted", "→")} ${theme.fg("accent", to)} ${theme.fg(color, `[${email.priority.toUpperCase()}]`)}`;
    text += `\n${theme.fg("toolTitle", subject)}`;
    text += `\n\n${theme.fg("customMessageText", expanded ? body : truncateText(body, 500))}`;
    if (expanded) {
      const id = sanitizeConversationLabel(email.id);
      const kind = sanitizeConversationLabel(email.kind);
      const reply = email.inReplyTo ? ` · reply to ${sanitizeConversationLabel(email.inReplyTo)}` : "";
      const createdAt = sanitizeConversationLabel(email.createdAt);
      text += `\n\n${theme.fg("dim", `id ${id} · ${kind}${reply} · ${createdAt}`)}`;
      const conversation = recordedConversationPreview(email.from);
      if (conversation) {
        text += `\n\n${theme.fg("toolTitle", "Recent subagent conversation")}\n${theme.fg("customMessageText", conversation)}`;
      } else {
        text += `\n\n${theme.fg("dim", "Conversation preview is loading. Full transcript: /agents → select agent → Ctrl+O")}`;
      }
    }
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  pi.registerMessageRenderer<{ message: string }>(ALERT_TYPE, (message, _options, theme) => {
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const alert = sanitizeConversationBody(message.details?.message ?? String(message.content));
    box.addChild(new Text(`${theme.fg("error", "Subagent alert")}\n${theme.fg("customMessageText", alert)}`, 0, 0));
    return box;
  });

  async function showAgents(args: string, ctx: ExtensionContext): Promise<void> {
    if (!broker) {
      ctx.ui.notify("Email subagent broker is not ready.", "warning");
      return;
    }
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const action = parts[0];
    try {
      if (action === "stop" && parts[1]) {
        await broker.stop(parts[1]);
        ctx.ui.notify(`Stopped ${parts[1]}.`, "info");
      } else if (action === "restart" && parts[1]) {
        await broker.restart(parts[1]);
        ctx.ui.notify(`Restarted ${parts[1]}.`, "info");
      } else if (action === "archive" && parts[1]) {
        await broker.archive(parts[1]);
        ctx.ui.notify(`Archived ${parts[1]}.`, "info");
      } else if (action === "cancel") {
        if (!parts[1] || parts.length < 3) throw new Error("Usage: /agents cancel <request-id> <reason>");
        const cancelled = await broker.cancelRequest(parts[1], parts.slice(2).join(" "));
        ctx.ui.notify(`Cancelled ${cancelled.id} to ${cancelled.to}.`, "info");
      } else if (action === "clear-failure" && parts[1]) {
        await broker.clearFailure(parts[1]);
        ctx.ui.notify(`Cleared failure for ${parts[1]}.`, "info");
      } else if (action === "effort" && parts[1] && parts[2]) {
        if (!isThinkingLevel(parts[2])) throw new Error(`Invalid effort ${parts[2]}.`);
        await broker.setEffort(parts[1], parts[2]);
        ctx.ui.notify(`${parts[1]} effort set to ${parts[2]}.`, "info");
      } else {
        await ui.showDashboard(ctx, broker, action);
      }
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  }

  pi.registerCommand("agents", {
    description: "Inspect and control email subagents: /agents [address|stop|restart|archive|cancel|clear-failure|effort]",
    handler: showAgents,
  });

  pi.registerShortcut(Key.ctrlShift("a"), {
    description: "Open email subagent dashboard",
    handler: async (ctx) => showAgents("", ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    generation += 1;
    const myGeneration = generation;
    currentContext = ctx;
    effectiveConfig = undefined;
    latestBrokerSnapshot = undefined;
    conversationSources.clear();
    ui.bind(ctx);
    if (broker) {
      try {
        await broker.shutdown();
      } catch (error) {
        broker = undefined;
        if (generation === myGeneration) {
          ctx.ui.notify(`Email subagent handoff blocked: prior broker cleanup is not quiescent: ${errorMessage(error)}`, "error");
        }
        return;
      }
    }
    if (generation !== myGeneration) return;
    broker = undefined;

    if (!ctx.model) {
      ctx.ui.notify("pi-email-subagent requires an active model.", "warning");
      return;
    }

    const agentDir = getAgentDir();
    const configResult = loadConfig(agentDir, ctx.cwd, ctx.isProjectTrusted());
    effectiveConfig = configResult.config;
    for (const warning of configResult.warnings) ctx.ui.notify(warning, "warning");
    mainAddress = makeMainAddress(ctx.model.id);
    mainAliases = new Set([mainAddress]);

    const runtimeFactory = new WorkerRuntimeFactory(ctx.modelRegistry, {
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });

    const adapter: MainAdapter = {
      getAddress: () => mainAddress,
      getAliases: () => mainAliases,
      async deliver({ envelope, formatted, triggerTurn = true }) {
        if (generation !== myGeneration) throw new Error("Main session was replaced before delivery.");
        pi.sendMessage(
          { customType: MESSAGE_TYPE, content: formatted, display: true, details: envelope },
          triggerTurn
            ? { triggerTurn: true, deliverAs: envelope.priority === "high" ? "steer" : "followUp" }
            : { triggerTurn: false },
        );
      },
      notifyFailure(message) {
        if (generation !== myGeneration) return;
        try {
          currentContext?.ui.notify(message, "error");
          pi.sendMessage(
            { customType: ALERT_TYPE, content: formatAlert(message), display: true, details: { message } },
            { triggerTurn: true, deliverAs: "steer" },
          );
        } catch { /* stale runtime */ }
      },
      updateState(snapshot: BrokerSnapshot) {
        if (generation !== myGeneration) return;
        latestBrokerSnapshot = snapshot;
        ui.update(snapshot);
        refreshConversationSources(snapshot, myGeneration).catch(() => undefined);
      },
    };

    const next = new AgentBroker({
      cwd: ctx.cwd,
      agentDir,
      namespaceDir: join(agentDir, "subagents", ctx.sessionManager.getSessionId()),
      config: configResult.config,
      models: availableModels(ctx),
      preferredProvider: ctx.model?.provider,
      mainAdapter: adapter,
      workerFactory: async (model) => {
        const snapshot = await runtimeFactory.create(model.provider, model.id);
        return new SdkWorker(snapshot.runtime, snapshot.model);
      },
      projectTrusted: ctx.isProjectTrusted(),
    });
    broker = next;
    try {
      await next.init();
      if (generation !== myGeneration) {
        if (broker === next) broker = undefined;
        await next.shutdown();
      }
    } catch (error) {
      if (broker === next) broker = undefined;
      let cleanupError: unknown;
      try { await next.shutdown(); } catch (failure) { cleanupError = failure; }
      if (generation === myGeneration) {
        const suffix = cleanupError ? `; cleanup remains unsafe: ${errorMessage(cleanupError)}` : "";
        ctx.ui.notify(`Email subagent startup failed: ${errorMessage(error)}${suffix}`, "error");
      }
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!broker || !ctx.model) return;
    const prompt = mainCoordinatorPrompt(
      broker.mainAddress,
      ctx.model.id,
      pi.getThinkingLevel(),
      broker.modelIds,
      broker.fetchUnanswered(broker.mainAddress).length,
      effectiveConfig,
    );
    return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
  });

  pi.on("model_select", async (event) => {
    if (!broker) return;
    try {
      const next = makeMainAddress(event.model.id);
      mainAliases.add(mainAddress);
      mainAliases.add(next);
      mainAddress = next;
      await broker.updateMainModel(next, event.model.provider);
    } catch (error) {
      currentContext?.ui.notify(`Could not update main email address: ${errorMessage(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    generation += 1;
    const current = broker;
    broker = undefined;
    currentContext = undefined;
    effectiveConfig = undefined;
    latestBrokerSnapshot = undefined;
    conversationSources.clear();
    ui.clear();
    if (current) await current.shutdown();
  });
}
