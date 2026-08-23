import { existsSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_TIMER_DELAY_MS } from "./config.ts";
import type {
  ActivityItem,
  AgentRecord,
  EmailEnvelope,
  SendEmailInput,
  SendEmailResult,
  WorkerCleanupOptions,
  WorkerCleanupReport,
  WorkerEvent,
  WorkerSnapshot,
  WorkerStartConfig,
  WorkerTransport,
} from "./types.ts";
import { formatUnanswered } from "./prompts.ts";
import { textResult } from "./tool-result.ts";
import { clone, errorMessage, nowIso, truncateText } from "./util.ts";
import { appendRecent, beginBatch, classifyTool, emptyWorkState, finishWorkItem, interruptActive, noteInspection, recoverMutationWork, startWorkItem } from "./work-ledger.ts";

const PrioritySchema = StringEnum(["high", "low"] as const);
const EffortSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const LifecycleSchema = Type.Object({
  spawnTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  promptAcceptanceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  runTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  idleTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  abortTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  disposeTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
}, { additionalProperties: false, description: "Optional finite deadlines for a newly created recipient only; configured administrative maxima apply" });

export interface SendToolDetails {
  result?: SendEmailResult;
}

export interface FetchToolDetails {
  emails: EmailEnvelope[];
  total: number;
}

export function createWorkerMailTools(config: Pick<WorkerStartConfig, "sendEmail" | "fetchEmails">) {
  const send = defineTool({
    name: "send_email",
    label: "Send email",
    description:
      "Send virtual email to another Pi agent. Sender identity is automatic. Unknown valid recipients spawn; optional effort applies only to that initial creation. Use low normally and high only for blockers. To answer, copy the exact `Re: [mail-id] subject` from fetch_emails().",
    promptSnippet: "Send internal mail to persistent subagents; unknown valid addresses spawn.",
    promptGuidelines: [
      "Use low-priority email by default; high is only for blockers that should change ongoing work.",
      "Answer received requests with the exact reply subject returned by fetch_emails().",
      "Use send_email effort only on the first request that creates an unknown identity; later mail cannot mutate persisted effort.",
    ],
    executionMode: "parallel" as const,
    parameters: Type.Object({
      to: Type.String({ description: "Recipient `<name>.<task-slug>@<registered-model>.com` or a main address" }),
      subject: Type.String({ description: "New subject, or exact reply subject from fetch_emails()" }),
      message: Type.String({ description: "Self-contained request or substantive response" }),
      priority: PrioritySchema,
      effort: Type.Optional(EffortSchema),
      lifecycle: Type.Optional(LifecycleSchema),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error("Email send aborted before acceptance.");
      try {
        const result = await config.sendEmail(params as SendEmailInput);
        const lines = [
          "Email accepted.",
          `ID: ${result.envelope.id}`,
          `To: ${result.envelope.to}`,
          `Priority: ${result.envelope.priority}`,
          `Spawned recipient: ${result.spawned ? "yes" : "no"}`,
          `Recipient disposition: ${result.recipientDisposition}`,
          `Delivery state: ${result.envelope.deliveryState}`,
          `Correlation ID: ${result.correlationId}`,
          `Expected reply subject: ${result.expectedReplySubject ?? "none"}`,
          `Answered email: ${result.answeredEmailId ?? "none"}`,
        ];
        if (result.recipientProvider && result.recipientModel) {
          lines.push(`Recipient model: ${result.recipientProvider}/${result.recipientModel}`);
          lines.push("Binding: persisted for this identity");
        } else if (result.recipientModel) lines.push(`Recipient model: ${result.recipientModel}`);
        if (result.recipientEffort) lines.push(`Recipient effort: ${result.recipientEffort}`);
        if (result.recipientRole) lines.push(`Recipient role: ${result.recipientRole}`);
        if (result.recipientTools) lines.push(`Recipient tools: ${result.recipientTools.join(", ")}`);
        if (result.recipientState) lines.push(`Recipient state: ${result.recipientState}`);
        if (result.recipientLifecycle) lines.push(`Recipient lifecycle: ${JSON.stringify(result.recipientLifecycle)}`);
        return textResult(lines.join("\n"), { result } satisfies SendToolDetails);
      } catch (error) {
        const message = errorMessage(error);
        // The broker may report a post-journal delivery problem. Do not
        // relabel a durable email.created commit as rejection.
        if (/^Email\s+\S+\s+was persisted\b/.test(message)) throw new Error(message);
        throw new Error(`Email was not accepted: ${message}`);
      }
    },
  });

  const fetch = defineTool({
    name: "fetch_emails",
    label: "Fetch unanswered emails",
    description:
      "Return response-required emails in your mailbox that do not yet have a successful reply. Call at the beginning of mailbox work and before stopping; use each exact Reply subject with send_email.",
    promptSnippet: "List your unanswered response-required virtual emails.",
    promptGuidelines: ["Before becoming idle, call fetch_emails() and substantively answer every returned request."],
    executionMode: "sequential" as const,
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const batch = config.fetchEmails();
      const suffix = batch.total > batch.emails.length
        ? `\n\nShowing ${batch.emails.length} of ${batch.total}; answer this batch, then call fetch_emails again for the remainder.`
        : "";
      return textResult(`${formatUnanswered(batch.emails)}${suffix}`, batch satisfies FetchToolDetails);
    },
  });

  return [send, fetch] as const;
}

function usageFromRecord(record: AgentRecord): AgentRecord["usage"] {
  return { ...record.usage };
}

export function awaitPromptAcceptance(
  start: (preflight: (success: boolean) => void) => Promise<void>,
  onError?: (error: unknown) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let accepted = false;
    let settled = false;
    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    void start((success) => {
      if (success) {
        accepted = true;
        resolveOnce();
      } else rejectOnce(new Error("Worker prompt was rejected during preflight."));
    }).then(() => {
      if (!accepted) rejectOnce(new Error("Worker prompt completed without being accepted."));
    }).catch((error: unknown) => {
      onError?.(error);
      if (!accepted) rejectOnce(error);
    });
  });
}

export function terminalAgentError(messages: readonly AgentMessage[], willRetry: boolean): string | undefined {
  if (willRetry) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.stopReason === "error") {
      return message.errorMessage?.trim() || "The model request failed without an error message.";
    }
  }
  return undefined;
}

export function effectiveWorkerModel(configModel: Model<any>, runtimeModel?: Model<any>): Model<any> {
  return runtimeModel ?? configModel;
}

export class SdkWorker implements WorkerTransport {
  private session?: AgentSession;
  private sessionManager?: SessionManager;
  private record?: AgentRecord;
  private listeners = new Set<(event: WorkerEvent) => void>();
  private unsubscribeSession?: () => void;
  private disposed = false;
  private cleanupPromise?: Promise<WorkerCleanupReport>;
  private readonly activeToolCalls = new Map<string, string>();
  private processCapableRisk = false;
  private startGeneration = 0;
  private runFailure?: string;
  private completionText?: string;
  private cwd = process.cwd();

  constructor(private readonly modelRuntime: ModelRuntime, private readonly runtimeModel?: Model<any>) {}

  subscribe(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: WorkerEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(event);
  }

  private activity(kind: ActivityItem["kind"], summary: string): void {
    if (!this.record) return;
    const item: ActivityItem = { at: nowIso(), kind, summary: truncateText(summary.replace(/\s+/g, " ").trim(), 500) };
    this.record.activity.push(item);
    if (this.record.activity.length > 40) this.record.activity.splice(0, this.record.activity.length - 40);
    this.record.lastActivityAt = item.at;
    this.record.currentActivity = item.summary;
    this.record.updatedAt = item.at;
    this.emit({ type: "activity", activity: item });
  }

  private setState(state: AgentRecord["state"]): void {
    if (!this.record) return;
    this.record.state = state;
    this.record.updatedAt = nowIso();
    this.emit({ type: "state", state });
  }

  async start(config: WorkerStartConfig): Promise<void> {
    if (this.session) return;
    if (this.disposed) throw new Error("Disposed workers cannot be restarted.");
    const generation = ++this.startGeneration;
    this.processCapableRisk = false;
    this.record = clone(config.record);
    this.record.work ??= emptyWorkState();
    this.cwd = config.cwd;
    this.setState("spawning");

    const settings = SettingsManager.create(config.cwd, config.agentDir, { projectTrusted: config.projectTrusted });
    const settingsErrors = settings.drainErrors();
    settings.applyOverrides({
      steeringMode: "all",
      followUpMode: "all",
      defaultThinkingLevel: this.record.effort,
    });
    for (const { scope } of settingsErrors) {
      this.activity("error", `Pi ${scope} settings could not be loaded; Pi fallback settings apply for that scope.`);
    }
    const loader = new DefaultResourceLoader({
      cwd: config.cwd,
      agentDir: config.agentDir,
      settingsManager: settings,
      noExtensions: true,
      noThemes: true,
      appendSystemPrompt: [config.systemPrompt],
    });
    await loader.reload();
    if (this.disposed || generation !== this.startGeneration) throw new Error("Worker start was cancelled.");

    const resumableSessionFile = this.record.sessionFile && existsSync(this.record.sessionFile)
      ? this.record.sessionFile
      : undefined;
    const sessionManager = resumableSessionFile
      ? SessionManager.open(resumableSessionFile, config.sessionDir, config.cwd)
      : SessionManager.create(config.cwd, config.sessionDir);

    this.sessionManager = sessionManager;
    try {
      this.record.work = recoverMutationWork(sessionManager.getBranch(), config.cwd, this.record.work);
    } catch (error) {
      this.record.work.recoveryError = truncateText(errorMessage(error), 500);
      interruptActive(this.record.work);
    }

    const requestedTools = [...this.record.tools];
    const { session } = await createAgentSession({
      cwd: config.cwd,
      agentDir: config.agentDir,
      modelRuntime: this.modelRuntime,
      model: effectiveWorkerModel(config.model, this.runtimeModel),
      thinkingLevel: this.record.effort,
      tools: this.record.tools,
      customTools: [...createWorkerMailTools(config)],
      resourceLoader: loader,
      sessionManager,
      settingsManager: settings,
      sessionStartEvent: { type: "session_start", reason: resumableSessionFile ? "resume" : "new" },
    });
    if (this.disposed || generation !== this.startGeneration) {
      if (session.isStreaming) await session.abort().catch(() => undefined);
      session.dispose();
      throw new Error("Worker start was cancelled.");
    }
    this.session = session;
    this.record.sessionFile = session.sessionFile;
    this.record.effort = session.thinkingLevel;
    this.record.tools = session.getActiveToolNames();
    if (!this.record.tools.includes("send_email") || !this.record.tools.includes("fetch_emails")) {
      throw new Error("Worker mailbox tools were not activated.");
    }
    this.unsubscribeSession = session.subscribe((event) => this.onSessionEvent(event));
    session.setSteeringMode("all");
    session.setFollowUpMode("all");
    this.setState("idle");
    const unknownTools = requestedTools.filter((tool) => !this.record!.tools.includes(tool));
    if (unknownTools.length > 0) this.activity("error", `Unknown tools omitted: ${unknownTools.join(", ")}`);
    this.activity("status", this.record.sessionFile ? "Session ready" : "Session ready in memory");
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    if (this.disposed || !this.record) return;
    switch (event.type) {
      case "agent_start":
        this.runFailure = undefined;
        this.completionText = undefined;
        this.setState("running");
        this.activity("status", "Agent run started");
        break;
      case "tool_execution_start": {
        // Pi 0.81.1 has no released receipt proving that descendants of a
        // completed built-in Bash call are absent. This risk belongs to the
        // whole worker generation, not only the active-call map.
        if (event.toolName.toLowerCase() === "bash") this.processCapableRisk = true;
        this.activeToolCalls.set(event.toolCallId, event.toolName);
        this.emit({
          type: "tool_lifecycle",
          phase: "start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          at: nowIso(),
        });
        const work = this.record.work ??= emptyWorkState();
        const toolClass = classifyTool(event.toolName);
        if (toolClass === "inspection") {
          noteInspection(work.inspection, event.toolName);
          this.emit({ type: "work" });
        }
        const item = startWorkItem(event.toolCallId, event.toolName, event.args, work.currentBatchId ?? 0, this.cwd);
        if (item) {
          work.active = [...work.active.filter((candidate) => candidate.toolCallId !== item.toolCallId), item];
          this.record.updatedAt = item.startedAt;
          this.emit({ type: "work", workItem: clone(item) });
          const target = item.displayPath ?? item.commandPreview ?? "";
          this.activity("tool", `${item.toolName}${target ? ` ${target}` : ""} started`);
        } else if (toolClass === "mailbox") this.activity("tool", `${event.toolName} started`);
        break;
      }
      case "tool_execution_update":
        this.emit({
          type: "tool_lifecycle",
          phase: "progress",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          at: nowIso(),
        });
        break;
      case "tool_execution_end": {
        this.activeToolCalls.delete(event.toolCallId);
        this.emit({
          type: "tool_lifecycle",
          phase: "end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          at: nowIso(),
        });
        const work = this.record.work ??= emptyWorkState();
        const index = work.active.findIndex((candidate) => candidate.toolCallId === event.toolCallId);
        let item = index >= 0 ? work.active[index] : startWorkItem(event.toolCallId, event.toolName, undefined, work.currentBatchId ?? 0, this.cwd);
        if (index >= 0) work.active.splice(index, 1);
        if (item) {
          const mismatch = item.toolName !== event.toolName;
          item = finishWorkItem(item, mismatch ? undefined : event.result, event.isError || mismatch);
          appendRecent(work, item);
          this.emit({ type: "work", workItem: clone(item) });
          const failed = item.status === "failed";
          this.activity(failed ? "error" : "tool", `${item.toolName} ${failed ? `failed${item.error ? `: ${item.error}` : ""}` : "completed"}`);
        } else if (classifyTool(event.toolName) === "mailbox") {
          this.activity(event.isError ? "error" : "tool", `${event.toolName} ${event.isError ? "failed" : "completed"}`);
        }
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const text = event.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (text) {
          this.completionText = text;
          this.activity("text", text);
        }
        const usage = event.message.usage;
        if (usage) {
          this.record.usage.input += usage.input ?? 0;
          this.record.usage.output += usage.output ?? 0;
          this.record.usage.cacheRead += usage.cacheRead ?? 0;
          this.record.usage.cacheWrite += usage.cacheWrite ?? 0;
          this.record.usage.cost += usage.cost?.total ?? 0;
          this.record.usage.contextTokens = usage.totalTokens ?? this.record.usage.contextTokens;
          this.record.usage.turns += 1;
        }
        break;
      }
      case "auto_retry_start":
        this.activity("status", `Provider retry ${event.attempt}/${event.maxAttempts} scheduled in ${event.delayMs}ms: ${event.errorMessage}`);
        break;
      case "auto_retry_end":
        if (event.success) this.activity("status", `Provider retry recovered after attempt ${event.attempt}`);
        else this.activity("error", `Provider retry ended after attempt ${event.attempt}: ${event.finalError ?? "unknown error"}`);
        break;
      case "agent_end": {
        const failure = terminalAgentError(event.messages, event.willRetry);
        if (failure) {
          this.runFailure = failure;
          this.activity("error", failure);
        }
        break;
      }
      case "agent_settled":
        if (this.record.work) {
          interruptActive(this.record.work);
          this.record.work.batchEndedAt = nowIso();
        }
        if (this.runFailure) {
          this.setState("failed");
          this.activity("status", "Agent run failed");
          this.emit({ type: "failure", error: this.runFailure });
        } else {
          this.setState("idle");
          this.activity("status", "Agent run settled");
        }
        this.emit({ type: "settled", ...(this.completionText ? { completionText: this.completionText } : {}) });
        this.runFailure = undefined;
        this.completionText = undefined;
        break;
      default:
        break;
    }
  }

  private requiredSession(): AgentSession {
    if (!this.session || this.disposed) throw new Error("Worker session is not available.");
    return this.session;
  }

  async prompt(message: string, options: { newBatch?: boolean } = {}): Promise<void> {
    const session = this.requiredSession();
    if (!session.isIdle) throw new Error("Worker is not idle; use steer or follow-up delivery.");
    const previousWork = clone(this.record!.work ??= emptyWorkState());
    const startsBatch = options.newBatch !== false;
    const batchId = startsBatch ? beginBatch(this.record!.work) : (this.record!.work.currentBatchId ?? beginBatch(this.record!.work));
    try {
      await awaitPromptAcceptance(
        (preflightResult) => session.prompt(message, {
          source: "extension",
          expandPromptTemplates: false,
          preflightResult: (success) => {
            if (success && startsBatch) this.sessionManager?.appendCustomEntry("pi-email-subagent-work-batch", {
              batchId,
              startedAt: this.record!.work!.batchStartedAt,
            });
            preflightResult(success);
          },
        }),
        (error) => {
          const messageText = errorMessage(error);
          this.activity("error", messageText);
          this.emit({ type: "failure", error: messageText });
        },
      );
    } catch (error) {
      this.record!.work = previousWork;
      throw error;
    }
  }

  async steer(message: string): Promise<void> {
    await this.requiredSession().steer(message);
  }

  async followUp(message: string): Promise<void> {
    await this.requiredSession().followUp(message);
  }

  async abort(): Promise<void> {
    try {
      if (this.session?.isStreaming) await this.session.abort();
    } finally {
      if (this.record?.work) interruptActive(this.record.work);
      this.setState("stopped");
    }
  }

  cleanup(_options: WorkerCleanupOptions): Promise<WorkerCleanupReport> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.disposed = true;
    this.startGeneration += 1;
    const session = this.session;
    const unsubscribe = this.unsubscribeSession;
    const activeTools = [...this.activeToolCalls].map(([toolCallId, toolName]) => ({ toolCallId, toolName }));
    const processCapableRisk = this.processCapableRisk;
    this.session = undefined;
    this.sessionManager = undefined;
    this.unsubscribeSession = undefined;
    this.activeToolCalls.clear();
    unsubscribe?.();

    const operation = (async (): Promise<WorkerCleanupReport> => {
      let abort: WorkerCleanupReport["abort"] = "succeeded";
      let dispose: WorkerCleanupReport["dispose"] = "succeeded";
      let providerQuiescent = !session?.isStreaming;
      let detail: string | undefined;
      if (session?.isStreaming) {
        // The broker owns caller responsiveness. A timeout there is not
        // cancellation here: this one authoritative operation stays pending
        // until Pi's abort actually settles, then disposes the session once.
        try {
          await session.abort();
          abort = "succeeded";
          providerQuiescent = true;
        } catch (error) {
          abort = "failed";
          providerQuiescent = false;
          detail = truncateText(errorMessage(error), 500);
        }
      }
      try {
        session?.dispose();
      } catch (error) {
        dispose = "failed";
        detail = truncateText(errorMessage(error), 500);
      } finally {
        this.listeners.clear();
      }
      const tools = activeTools.map((tool) => ({
        ...tool,
        quiescence: "unknown" as const,
        detailCode: "PI_TOOL_QUIESCENCE_RECEIPT_UNAVAILABLE",
      }));
      const quiescence = providerQuiescent
        && dispose === "succeeded"
        && tools.length === 0
        && !processCapableRisk
        ? "verified" as const
        : "unknown" as const;
      return {
        sessionDisposed: dispose === "succeeded",
        providerQuiescent,
        tools,
        quiescence,
        source: quiescence === "verified"
          ? "pi-agent-session-idle-with-no-process-capable-tool-risk"
          : processCapableRisk
            ? "pi-0.81.1-bash-process-quiescence-receipt-unavailable"
            : "pi-0.81.1-no-tool-process-quiescence-receipt",
        abort,
        dispose,
        ...(detail ? { detail } : {}),
      };
    })();
    this.cleanupPromise = operation;
    return operation;
  }

  async dispose(): Promise<void> {
    const report = await this.cleanup({ abortTimeoutMs: MAX_TIMER_DELAY_MS });
    if (report.abort === "failed" || report.dispose === "failed") {
      throw new Error(report.detail ?? "Worker cleanup failed.");
    }
  }

  setEffort(level: AgentRecord["effort"]): void {
    const session = this.requiredSession();
    if (!session.isIdle) throw new Error("Effort can only be changed while the worker is idle.");
    session.setThinkingLevel(level);
    if (this.record) this.record.effort = session.thinkingLevel;
  }

  getSnapshot(): WorkerSnapshot {
    if (!this.record) throw new Error("Worker has not started.");
    return {
      record: { ...clone(this.record), usage: usageFromRecord(this.record) },
      isIdle: this.session?.isIdle ?? true,
      isStreaming: this.session?.isStreaming ?? false,
    };
  }

  getSessionFile(): string | undefined {
    return this.session?.sessionFile ?? this.record?.sessionFile;
  }
}
