import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import { makeMainAddress } from "./address.ts";
import { AgentBroker } from "./broker.ts";
import { DEFAULT_MODEL_POLICY, isThinkingLevel, loadConfig } from "./config.ts";
import { createMainCoordinationTools } from "./main-tools.ts";
import { WorkerRuntimeFactory, type WorkerRuntimeSnapshot } from "./model-runtime.ts";
import { assertExtensionApiFeatures } from "./pi-compat.ts";
import { budgetPromptAdditions, formatAlert, mainCoordinatorPrompt } from "./prompts.ts";
import { isMechanisticAddress } from "./mechanistic.ts";
import { deadlineSignal, lifecycleDuration } from "./runtime-timers.ts";
import { createWorkerMailTools, type FetchToolDetails, type SendToolDetails, SdkWorker } from "./sdk-worker.ts";
import { safeErrorSummary } from "./safe-summary.ts";
import { WorkerSettingsSnapshot } from "./settings-snapshot.ts";
import type { BrokerSnapshot, EmailEnvelope, MainAdapter, SubagentConfig } from "./types.ts";
import {
  ConversationSource,
  formatConversationPreview,
  HISTORY_PREVIEW_MAX_BLOCKS,
  sanitizeConversationBody,
  sanitizeConversationLabel,
  UIController,
} from "./ui.ts";
import { truncateText } from "./util.ts";
import { collectWorkerExtensions } from "./worker-extensions.ts";

const errorMessage = safeErrorSummary;
const { getAgentDir } = PiCodingAgent;
const { Box, Key, Text } = PiTui;
const MESSAGE_TYPE = "pi-email-subagent.email";
const ALERT_TYPE = "pi-email-subagent.alert";
const COMMAND_TYPE = "pi-email-subagent.command";

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
  assertExtensionApiFeatures(pi);
  const ui = new UIController();
  let broker: AgentBroker | undefined;
  let brokerSessionId: string | undefined;
  let unsettledBroker: AgentBroker | undefined;
  let brokerStartup: { sessionId: string; promise: Promise<AgentBroker> } | undefined;
  let mainAddress = "";
  let mainAliases = new Set<string>();
  let currentContext: ExtensionContext | undefined;
  let effectiveConfig: SubagentConfig | undefined;
  let latestBrokerSnapshot: BrokerSnapshot | undefined;
  let generation = 0;
  let mainFlushTimer: ReturnType<typeof setTimeout> | undefined;
  const conversationSources = new Map<string, ConversationSource>();
  const commandChecks = new Set<() => void>();

  const cancelMainFlush = (): void => {
    if (mainFlushTimer) clearTimeout(mainFlushTimer);
    mainFlushTimer = undefined;
  };

  const recordedConversationPreview = (address: string): string | undefined => {
    const source = conversationSources.get(address.toLowerCase());
    return source ? formatConversationPreview(source.blocks) : undefined;
  };

  const refreshConversationSources = async (snapshot: BrokerSnapshot, expectedGeneration: number): Promise<void> => {
    const retained = new Set<string>();
    const refreshes: Promise<boolean>[] = [];
    for (const record of snapshot.agents) {
      if (record.kind !== "llm" || !record.sessionFile) continue;
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
    sendEmail: async (input, signal) => {
      const active = await ensureBroker(currentContext);
      if (!currentContext?.model) throw new Error("Email delegation requires an active model.");
      budgetPromptAdditions(effectiveConfig?.modelPolicy ?? DEFAULT_MODEL_POLICY, undefined, currentContext.model);
      return active.send(active.mainAddress, input, signal);
    },
    fetchEmails: async () => {
      const active = await ensureBroker(currentContext);
      return active.fetchUnansweredBatch(active.mainAddress);
    },
  });

  const registerSend = (description: string): void => pi.registerTool({
    ...sendTool,
    description,
    renderCall(args: any, theme) {
      const priorityColor = args.priority === "high" ? "warning" : "accent";
      const priority = sanitizeConversationLabel(String(args.priority ?? "")).toUpperCase();
      const subject = truncateText(sanitizeConversationLabel(String(args.subject || (args.reply_to ? `reply to ${args.reply_to}` : "(no subject)"))), 100);
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
          : (sent.recipientKind === "mechanistic" ? `Python: ${sent.recipientBinding?.script ?? "registered program"}` : sent.recipientModel ?? "main"),
      );
      const effort = sent.recipientEffort ? ` · effort ${sanitizeConversationLabel(sent.recipientEffort)}` : "";
      let text = `${icon} ${theme.fg("accent", recipient)} ${theme.fg("muted", envelopeId)}`;
      text += `\n${theme.fg("dim", `${disposition} · ${model}${effort}`)}`;
      if (sent.deliveryUncertain) {
        text += `\n${theme.fg("warning", `delivery uncertain: ${sanitizeConversationLabel(sent.deliveryUncertain.code)}`)}`;
      }
      if (sent.expectedReplySubject) text += `\n${theme.fg("muted", `reply: ${sanitizeConversationLabel(sent.expectedReplySubject)}`)}`;
      if (sent.answeredEmailId) text += `\n${theme.fg("success", `answered ${sanitizeConversationLabel(sent.answeredEmailId)}`)}`;
      if (expanded) {
        text += `\n\n${theme.fg("toolOutput", sanitizeConversationBody(sent.envelope.message))}`;
        const conversation = recordedConversationPreview(sent.envelope.to);
        if (conversation) {
          text += `\n\n${theme.fg("toolTitle", "Recent subagent conversation")}\n${theme.fg("toolOutput", conversation)}`;
        } else if (sent.recipientKind === "mechanistic") {
          text += `\n\n${theme.fg("dim", "Send-only Python job. Inspect /agents for progress, runtime outcome, and direct-child cleanup evidence.")}`;
        } else if (sent.envelope.to !== broker?.mainAddress) {
          text += `\n\n${theme.fg("dim", "Conversation preview is loading. Full transcript: /agents → select agent → Ctrl+O")}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  registerSend(sendTool.description);

  const [inspectAgentTool, waitForRepliesTool, cancelRequestTool, manageAgentTool] = createMainCoordinationTools(
    () => ensureBroker(currentContext),
  );

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
      } else if (email.from.endsWith("@mechanistic.com")) {
        text += `\n\n${theme.fg("dim", "Send-only Python status. Inspect /agents for job evidence; no conversation or inbox exists.")}`;
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

  pi.registerMessageRenderer(COMMAND_TYPE, (message, _options, theme) =>
    new Text(theme.fg("toolOutput", sanitizeConversationBody(String(message.content))), 0, 0));

  function commandOutput(ctx: ExtensionContext, content: string, details?: unknown): void {
    const text = sanitizeConversationBody(content);
    pi.sendMessage({ customType: COMMAND_TYPE, content: text, display: true, details }, { triggerTurn: false });
    // Pi 0.85.1 prints only assistant text and redirects process.stdout.write
    // to stderr. Write bounded command text to fd 1 only in print mode.
    if (ctx.mode === "print") writeFileSync(1, `${text}\n`);
  }

  // A command-local observation, not a mailbox wait API. Synchronous checks
  // never acquire broker locks or await the callback that is publishing them.
  async function finishDirectCommand(active: AgentBroker, id: string, timeoutMs: number): Promise<void> {
    const deadline = deadlineSignal(timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error): void => { commandChecks.delete(check); error ? reject(error) : resolve(); };
        const check = (): void => {
          try {
            if (broker !== active) return finish(new Error(`Job ${id} was accepted; session replaced. Inspect this exact ID; do not resend or replay.`));
            const { job, settled } = active.inspectMechanisticJob(id);
            if (settled && job.outcomeDeliveryState === "delivered") return finish();
            if (settled && job.outcomeDeliveryState === "failed") return finish(new Error(`Job ${id}: ${job.result}; outcome delivery failed. Inspect this ID; do not resend or replay.`));
            const inspection = active.inspectAgent(job.address);
            if (job.phase === "queued" && ["stopped", "failed", "paused"].includes(inspection.state)) return finish(new Error(`Job ${id} remains queued; recipient ${inspection.state}. Inspect this ID and cleanup evidence before explicit recovery; do not resend.`));
          } catch {
            // Observation must never throw back into broker publication,
            // retention or lifecycle callbacks, including another job's run.
            finish(new Error(`Job ${id} was accepted; command observation failed. Inspect this exact ID; do not resend or replay.`));
          }
        };
        commandChecks.add(check);
        void deadline.promise.then(() => finish(new Error(`Job ${id} was accepted; command deadline expired before terminal/delivery/cleanup settlement. Inspect this exact ID; do not resend or replay.`)));
        check();
      });
    } finally { deadline.cancel(); }
  }

  async function showAgents(args: string, ctx: ExtensionContext): Promise<void> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const action = parts[0];
    if (ctx.mode !== "tui" && !["run", "program", "programs"].includes(action ?? "")) {
      throw new Error("/agents is available only in TUI mode for dashboard/control. Use inspect_agent and manage_agent, or /agents run, /agents programs and /agents program for direct headless Python work.");
    }
    try {
      const active = await ensureBroker(ctx);
      if (action === "run") {
        currentContext = ctx;
        const match = /^run\s+(\S+)\s+([\s\S]+)$/.exec(args.trim());
        if (!match) throw new Error("Usage: /agents run <program>.<task-slug> <JSON input>");
        const address = match[1]!.includes("@") ? match[1]! : `${match[1]}@mechanistic.com`;
        if (!isMechanisticAddress(address)) throw new Error("/agents run accepts registered Python programs only; use send_email for LLM agents.");
        // Keep the body opaque: Python validates JSON only after durable acceptance.
        const sent = await active.send(active.mainAddress, { to: address, subject: `Run ${match[1]}`, message: match[2]!, priority: "low" }, undefined, undefined, { triggerTurn: false });
        const { job } = active.inspectMechanisticJob(sent.envelope.id);
        commandOutput(ctx, `Python job accepted: ${job.id} · ${job.address} · ${job.phase} (recipient ${sent.recipientState}). Acceptance is not completion; do not resend/replay.`, { jobId: job.id, address: job.address, phase: job.phase, recipientState: sent.recipientState, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), sessionFilePersisted: Boolean(ctx.sessionManager.getSessionFile() && existsSync(ctx.sessionManager.getSessionFile()!)) });
        if (ctx.mode !== "tui") await finishDirectCommand(active, job.id, lifecycleDuration(60_000, job.lifecycle.spawnTimeoutMs, job.lifecycle.runTimeoutMs, job.lifecycle.abortTimeoutMs, job.lifecycle.disposeTimeoutMs));
        return;
      }
      if (action === "programs" || action === "program") {
        const programs = Object.values(effectiveConfig?.mechanisticPrograms ?? {}).filter((program) => program.allowedCallers.includes("main"));
        if (action === "programs") commandOutput(ctx, programs.map((program) => `${program.key}: ${program.description ?? "registered Python program"}`).join("\n") || "No Python programs registered for main.");
        else {
          const program = programs.find((program) => program.key === parts[1]);
          if (!program) throw new Error("Usage: /agents program <registered name>; discover names with /agents programs.");
          commandOutput(ctx, [`${program.key}: ${program.description ?? "registered Python program"}`, `Binding: ${JSON.stringify({ python: program.python, script: program.script, cwd: program.cwd })}`, ...(program.inputExamples ?? []).map((example) => `Input example: ${example}`), `Run: /agents run ${program.key}.<task-slug> <JSON input>`].join("\n"), { program });
        }
        return;
      }
      if (action === "stop" && parts[1]) {
        await active.stop(parts[1]);
        ctx.ui.notify(`Stopped ${parts[1]}.`, "info");
      } else if (action === "restart" && parts[1]) {
        await active.restart(parts[1]);
        ctx.ui.notify(`Restarted ${parts[1]}.`, "info");
      } else if (action === "archive" && parts[1]) {
        await active.archive(parts[1]);
        ctx.ui.notify(`Archived ${parts[1]}.`, "info");
      } else if (action === "cancel") {
        if (!parts[1] || parts.length < 3) throw new Error("Usage: /agents cancel <request-id> <reason>");
        const cancelled = await active.cancelRequest(parts[1], parts.slice(2).join(" "));
        ctx.ui.notify(`Cancelled ${cancelled.id} to ${cancelled.to}.`, "info");
      } else if (action === "clear-failure" && parts[1]) {
        await active.clearFailure(parts[1]);
        ctx.ui.notify(`Cleared failure for ${parts[1]}.`, "info");
      } else if (action === "effort" && parts[1] && parts[2]) {
        if (!isThinkingLevel(parts[2])) throw new Error(`Invalid effort ${parts[2]}.`);
        await active.setEffort(parts[1], parts[2]);
        ctx.ui.notify(`${parts[1]} effort set to ${parts[2]}.`, "info");
      } else {
        await ui.showDashboard(ctx, active, action);
      }
    } catch (error) {
      if (["run", "program", "programs"].includes(action ?? "") || ctx.mode !== "tui") commandOutput(ctx, `Command failed: ${errorMessage(error)}`, { error: true });
      else ctx.ui.notify(errorMessage(error), "error");
    }
  }

  pi.registerCommand("agents", {
    description: "Python: /agents run <program>.<task-slug> <JSON> | programs | program <name>; TUI: inspect/control agents",
    handler: showAgents,
  });

  pi.registerShortcut(Key.ctrlShift("a"), {
    description: "Open email subagent dashboard",
    handler: async (ctx) => showAgents("", ctx),
  });

  async function startBroker(ctx: ExtensionContext): Promise<AgentBroker> {
    generation += 1;
    const myGeneration = generation;
    currentContext = ctx;
    ui.bind(ctx);
    const prior = broker ?? unsettledBroker;
    if (prior) {
      try {
        await prior.shutdown();
        unsettledBroker = undefined;
      } catch (error) {
        if (broker === prior) broker = undefined;
        brokerSessionId = undefined;
        unsettledBroker = prior;
        throw new Error(`prior broker Pi session/tool cleanup is unsettled: ${errorMessage(error)}`);
      }
    }
    if (generation !== myGeneration) throw new Error("the session was replaced during broker startup");
    broker = undefined;
    brokerSessionId = undefined;

    if (!ctx.model) throw new Error("pi-email-subagent requires an active model");

    const agentDir = getAgentDir();
    const projectTrusted = ctx.isProjectTrusted();
    const workerSettings = WorkerSettingsSnapshot.capture(ctx.cwd, agentDir, projectTrusted);
    const workerExtensionCollection = collectWorkerExtensions(pi.events);
    const workerExtensions = workerExtensionCollection.registrations;
    const workerExtensionEffects = Object.fromEntries(
      workerExtensions.flatMap((registration) => Object.entries(registration.effects)),
    );
    for (const issue of workerExtensionCollection.issues) ctx.ui.notify(issue, "warning");
    for (const { scope } of workerSettings.loadIssues) {
      ctx.ui.notify(`Pi ${scope} settings could not be loaded; the worker snapshot uses Pi fallback settings for that scope.`, "warning");
    }
    const configResult = loadConfig(agentDir, ctx.cwd, projectTrusted);
    effectiveConfig = configResult.config;
    for (const warning of configResult.warnings) ctx.ui.notify(warning, "warning");
    budgetPromptAdditions(effectiveConfig.modelPolicy, undefined, ctx.model);
    mainAddress = makeMainAddress(ctx.model.id);
    mainAliases = new Set([mainAddress]);

    const runtimeFactory = new WorkerRuntimeFactory(ctx.modelRegistry, {
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });

    const adapter: MainAdapter = {
      getAddress: () => mainAddress,
      getAliases: () => mainAliases,
      isIdle: () => ctx.isIdle(),
      async deliver({ envelope, formatted, triggerTurn = true }) {
        if (generation !== myGeneration) throw new Error("Main session was replaced before delivery.");
        pi.sendMessage(
          { customType: MESSAGE_TYPE, content: formatted, display: true, details: envelope },
          triggerTurn
            ? { triggerTurn: true, deliverAs: envelope.priority === "high" ? "steer" : "followUp" }
            : { triggerTurn: false },
        );
        if (!triggerTurn && ctx.mode === "print") writeFileSync(1, `${sanitizeConversationBody(envelope.message)}\n`);
      },
      notifyFailure(message, { triggerTurn = true } = {}) {
        if (generation !== myGeneration) return;
        try {
          currentContext?.ui.notify(message, "error");
          pi.sendMessage(
            { customType: ALERT_TYPE, content: formatAlert(message), display: true, details: { message } },
            triggerTurn ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false },
          );
          if (!triggerTurn && ctx.mode === "print") writeFileSync(1, `${sanitizeConversationBody(message)}\n`);
        } catch { /* stale runtime */ }
      },
      updateState(snapshot: BrokerSnapshot) {
        if (generation !== myGeneration) return;
        latestBrokerSnapshot = snapshot;
        ui.update(snapshot);
        for (const check of commandChecks) check();
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
      workerExtensionEffects,
      workerPreflight: (model) => runtimeFactory.preflight(model.provider, model.id),
      workerFactory: async (model, preparation) => {
        const snapshot = preparation as WorkerRuntimeSnapshot | undefined
          ?? await runtimeFactory.create(model.provider, model.id);
        if (snapshot.model.provider !== model.provider || snapshot.model.id !== model.id) {
          throw new Error("Prepared worker runtime does not match the exact selected provider/model binding.");
        }
        return new SdkWorker(snapshot.runtime, snapshot.model, workerSettings, workerExtensions);
      },
      projectTrusted,
    });
    broker = next;
    brokerSessionId = ctx.sessionManager.getSessionId();
    try {
      await next.init();
      if (generation !== myGeneration) {
        if (broker === next) broker = undefined;
        brokerSessionId = undefined;
        await next.shutdown();
        throw new Error("the session was replaced during broker startup");
      }
      return next;
    } catch (error) {
      if (broker === next) broker = undefined;
      brokerSessionId = undefined;
      let cleanupError: unknown;
      try { await next.shutdown(); } catch (failure) { cleanupError = failure; }
      const suffix = cleanupError ? `; cleanup remains unsafe: ${errorMessage(cleanupError)}` : "";
      throw new Error(`${errorMessage(error)}${suffix}`);
    }
  }

  /**
   * Return the live broker, transparently (re)starting it when startup
   * previously failed or the session switched. Concurrent callers share one
   * in-flight startup per session; a failed attempt rejects with the
   * actionable cause and never poisons later retries.
   */
  function ensureBroker(ctx: ExtensionContext | undefined): Promise<AgentBroker> {
    const sessionId = ctx?.sessionManager.getSessionId();
    if (broker && brokerSessionId === sessionId) return Promise.resolve(broker);
    if (!ctx || !sessionId) {
      return Promise.reject(new Error("Email broker is not ready: no active session is available to restart it."));
    }
    if (!brokerStartup || brokerStartup.sessionId !== sessionId) {
      const promise = startBroker(ctx).catch((error) => {
        throw new Error(`Email broker startup failed: ${errorMessage(error)}`);
      });
      brokerStartup = { sessionId, promise };
      void promise.catch(() => undefined).finally(() => {
        if (brokerStartup?.promise === promise) brokerStartup = undefined;
      });
    }
    return brokerStartup.promise;
  }

  pi.on("session_start", async (_event, ctx) => {
    cancelMainFlush();
    currentContext = ctx;
    effectiveConfig = undefined;
    latestBrokerSnapshot = undefined;
    conversationSources.clear();
    ui.bind(ctx);
    try {
      await ensureBroker(ctx);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    currentContext = ctx;
    if (!broker || !ctx.model) return;
    const additions = budgetPromptAdditions(
      effectiveConfig?.modelPolicy ?? DEFAULT_MODEL_POLICY,
      undefined,
      ctx.model,
    );
    const prompt = mainCoordinatorPrompt(
      broker.mainAddress,
      ctx.model.id,
      pi.getThinkingLevel(),
      broker.modelIds,
      broker.fetchUnanswered(broker.mainAddress).length,
      effectiveConfig ? { ...effectiveConfig, modelPolicy: additions.modelPolicy } : undefined,
    );
    if (event.systemPromptOptions?.sections) {
      // Persist guidance in the transcript so automatic mail-triggered turns,
      // which do not emit before_agent_start, retain the coordinator contract.
      event.systemPromptOptions.sections.email_coordination = prompt;
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (mainFlushTimer || !broker) return;
    const expectedGeneration = generation;
    const expectedBroker = broker;
    mainFlushTimer = setTimeout(() => {
      mainFlushTimer = undefined;
      if (generation !== expectedGeneration || broker !== expectedBroker || !ctx.isIdle()) return;
      void expectedBroker.flushQueuedMainMail().catch((error) => {
        if (generation === expectedGeneration && broker === expectedBroker) {
          ctx.ui.notify(`Could not deliver queued main mail: ${errorMessage(error)}`, "error");
        }
      });
    }, 0);
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
    cancelMainFlush();
    generation += 1;
    const current = broker ?? unsettledBroker;
    broker = undefined;
    brokerSessionId = undefined;
    unsettledBroker = undefined;
    brokerStartup = undefined;
    currentContext = undefined;
    for (const check of commandChecks) check();
    effectiveConfig = undefined;
    latestBrokerSnapshot = undefined;
    conversationSources.clear();
    ui.clear();
    if (current) await current.shutdown();
  });
}
