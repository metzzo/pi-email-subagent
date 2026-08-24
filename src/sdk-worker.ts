import { existsSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as PiAi from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import * as TypeBox from "typebox";
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
import { processQuiescenceReceiptCapability } from "./pi-compat.ts";
import { formatUnanswered } from "./prompts.ts";
import { safeErrorSummary } from "./safe-summary.ts";
import { runtimeSafeDelay } from "./runtime-timers.ts";
import { WorkerSettingsSnapshot } from "./settings-snapshot.ts";
import { textResult } from "./tool-result.ts";
import { clone, nowIso, truncateText } from "./util.ts";
import { appendRecent, beginBatch, classifyTool, emptyWorkState, finishWorkItem, interruptActive, noteInspection, recoverMutationWork, startWorkItem, unknownWorkItem } from "./work-ledger.ts";

const { Type } = TypeBox;
const PROCESS_QUIESCENCE_RECEIPT = processQuiescenceReceiptCapability();

export interface SendToolDetails {
  result?: SendEmailResult;
}

export interface FetchToolDetails {
  emails: EmailEnvelope[];
  total: number;
}

export function createWorkerMailTools(config: Pick<WorkerStartConfig, "sendEmail" | "fetchEmails">) {
  const PrioritySchema = PiAi.StringEnum(["high", "low"] as const);
  const EffortSchema = PiAi.StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
  const LifecycleSchema = Type.Object({
    spawnTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
    promptAcceptanceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
    runTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
    idleTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
    abortTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
    disposeTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMER_DELAY_MS })),
  }, { additionalProperties: false, description: "Optional finite deadlines for a newly created recipient only; configured administrative maxima apply" });
  const send = PiCodingAgent.defineTool({
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
        const result = await config.sendEmail(params as SendEmailInput, signal);
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
        if (result.recipientDisposition === "failed") {
          lines.push(result.recipientCleanup
            ? "Recipient recovery: mail is accepted and queued, but cleanup quiescence is unknown. Restart/archive are blocked and capacity remains held; external exact-generation quiescence review is required. Do not resend or redelegate the original scope."
            : "Recipient recovery: mail is accepted and queued; the recipient remains failed and no worker was spawned. Review Work and Conversation, then use explicit manage_agent restart for the same identity and provider binding only after effect review. Do not redelegate the same scope while the original obligation remains open.");
        }
        if (result.recipientProvider && result.recipientModel) {
          lines.push(`Recipient model: ${result.recipientProvider}/${result.recipientModel}`);
          lines.push("Binding: persisted for this identity");
        } else if (result.recipientModel) lines.push(`Recipient model: ${result.recipientModel}`);
        if (result.recipientEffort) lines.push(`Recipient effort: ${result.recipientEffort}`);
        if (result.recipientRole) lines.push(`Recipient role: ${result.recipientRole}`);
        if (result.recipientTools) lines.push(`Recipient tools: ${result.recipientTools.join(", ")}`);
        if (result.recipientState) lines.push(`Recipient state: ${result.recipientState}`);
        if (result.recipientLifecycle) lines.push(`Recipient lifecycle: ${JSON.stringify(result.recipientLifecycle)}`);
        if (result.recipientCleanup) lines.push(`Recipient cleanup: ${result.recipientCleanup.state} · generation ${result.recipientCleanup.workerGeneration} · quiescence unknown`);
        return textResult(lines.join("\n"), { result } satisfies SendToolDetails);
      } catch (error) {
        const message = safeErrorSummary(error);
        // The broker may report a post-journal delivery problem. Do not
        // relabel a durable email.created commit as rejection.
        if (/^Email\s+\S+\s+was persisted\b/.test(message)) throw new Error(message);
        throw new Error(`Email was not accepted: ${message}`);
      }
    },
  });

  const fetch = PiCodingAgent.defineTool({
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
      return safeErrorSummary(message.errorMessage);
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
  private startOperation?: Promise<void>;
  private runFailure?: string;
  private cwd = process.cwd();

  constructor(
    private readonly modelRuntime: ModelRuntime,
    private readonly runtimeModel?: Model<any>,
    private readonly settingsSnapshot?: WorkerSettingsSnapshot,
  ) {}

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
    const normalized = kind === "error" ? safeErrorSummary(summary) : summary.replace(/\s+/g, " ").trim();
    const item: ActivityItem = { at: nowIso(), kind, summary: truncateText(normalized, 500) };
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

  start(config: WorkerStartConfig): Promise<void> {
    if (this.startOperation) return this.startOperation;
    const operation = this.startInternal(config);
    this.startOperation = operation;
    return operation;
  }

  private async startInternal(config: WorkerStartConfig): Promise<void> {
    if (this.session) return;
    if (this.disposed) throw new Error("Disposed workers cannot be restarted.");
    const generation = ++this.startGeneration;
    this.processCapableRisk = false;
    this.record = clone(config.record);
    this.record.work ??= emptyWorkState();
    this.cwd = config.cwd;
    this.setState("spawning");

    const settings = this.settingsSnapshot?.createManager(this.record.effort)
      ?? PiCodingAgent.SettingsManager.inMemory({
        steeringMode: "all",
        followUpMode: "all",
        defaultThinkingLevel: this.record.effort,
      }, { projectTrusted: config.projectTrusted });
    const loader = new PiCodingAgent.DefaultResourceLoader({
      cwd: config.cwd,
      agentDir: config.agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [config.systemPrompt],
    });
    await loader.reload();
    if (this.disposed || generation !== this.startGeneration) throw new Error("Worker start was cancelled.");
    // One authoritative startup override after reload; later effort changes use
    // AgentSession.setThinkingLevel as their single setter.
    settings.applyOverrides({
      steeringMode: "all",
      followUpMode: "all",
      defaultThinkingLevel: this.record.effort,
    });

    const resumableSessionFile = this.record.sessionFile && existsSync(this.record.sessionFile)
      ? this.record.sessionFile
      : undefined;
    const sessionManager = resumableSessionFile
      ? PiCodingAgent.SessionManager.open(resumableSessionFile, config.sessionDir, config.cwd)
      : PiCodingAgent.SessionManager.create(config.cwd, config.sessionDir);

    this.sessionManager = sessionManager;
    try {
      this.record.work = recoverMutationWork(sessionManager.getBranch(), config.cwd, this.record.work);
    } catch (error) {
      this.record.work.recoveryError = safeErrorSummary(error);
      this.record.work.effectEvidenceUnavailable = true;
      interruptActive(this.record.work);
    }

    const requestedTools = [...this.record.tools];
    const { session } = await PiCodingAgent.createAgentSession({
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
        this.emit({ type: "run_liveness", phase: "model_start" });
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
        break;
      case "tool_execution_end": {
        if (event.toolName.toLowerCase() === "bash") this.processCapableRisk = true;
        this.activeToolCalls.delete(event.toolCallId);
        this.emit({
          type: "tool_lifecycle",
          phase: "end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        });
        const work = this.record.work ??= emptyWorkState();
        const index = work.active.findIndex((candidate) => candidate.toolCallId === event.toolCallId);
        const orphan = index < 0;
        let item = orphan
          ? startWorkItem(event.toolCallId, event.toolName, undefined, work.currentBatchId ?? 0, this.cwd)
          : work.active[index];
        if (index >= 0) work.active.splice(index, 1);
        if (item) {
          const mismatch = item.toolName !== event.toolName;
          const mutationPathUnknown = (item.kind === "edit" || item.kind === "write")
            && (item.attribution !== "explicit" || !item.path);
          if (orphan || mismatch || mutationPathUnknown) {
            item = unknownWorkItem(
              item,
              event.isError ? "error" : "success",
              orphan ? "missing-start" : mismatch ? "mismatched-tool" : "unsafe-path",
              undefined,
              mismatch ? event.toolName : item.toolName,
            );
          } else {
            item = finishWorkItem(item, item.attribution === "explicit" ? event.result : undefined, event.isError);
          }
          appendRecent(work, item);
          this.emit({ type: "work", workItem: clone(item) });
          if (item.status === "unknown") {
            this.activity("error", `${item.toolName} effect unknown/unverified (${item.observedResult ?? "terminal result unknown"}; ${item.reasonCode})`);
          } else if (item.attribution === "unverified") {
            this.activity(event.isError ? "error" : "tool", `${item.toolName} terminal ${event.isError ? "error" : "success"} observed; effects unverified`);
          } else {
            const failed = item.status === "failed";
            this.activity(failed ? "error" : "tool", `${item.toolName} ${failed ? `failed${item.error ? `: ${item.error}` : ""}` : "completed"}`);
          }
        } else if (classifyTool(event.toolName) === "mailbox") {
          this.activity(event.isError ? "error" : "tool", `${event.toolName} ${event.isError ? "failed" : "completed"}`);
        }
        break;
      }
      case "message_update":
        if (event.message.role === "assistant") this.emit({ type: "run_liveness", phase: "model_progress" });
        break;
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const text = event.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (text) this.activity("text", text);
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
        this.emit({ type: "run_liveness", phase: "retry_start", delayMs: Math.max(0, Math.min(MAX_TIMER_DELAY_MS, event.delayMs)) });
        this.activity("status", `Pi agent retry ${event.attempt}/${event.maxAttempts} scheduled in ${event.delayMs}ms: ${safeErrorSummary(event.errorMessage)}`);
        break;
      case "auto_retry_end":
        this.emit({ type: "run_liveness", phase: "retry_end" });
        if (event.success) this.activity("status", `Pi agent retry recovered after attempt ${event.attempt}`);
        else this.activity("error", `Pi agent retry ended after attempt ${event.attempt}: ${safeErrorSummary(event.finalError)}`);
        break;
      case "agent_end": {
        this.emit({ type: "run_liveness", phase: "model_end" });
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
        this.emit({ type: "settled" });
        this.runFailure = undefined;
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
          const messageText = safeErrorSummary(error);
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

  cleanup(options: WorkerCleanupOptions): Promise<WorkerCleanupReport> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.disposed = true;
    this.startGeneration += 1;
    const session = this.session;
    const unsubscribe = this.unsubscribeSession;
    const activeTools = [...this.activeToolCalls].map(([toolCallId, toolName]) => ({ toolCallId, toolName }));
    const processCapableRisk = this.processCapableRisk;
    const startOperation = this.startOperation;
    this.session = undefined;
    this.sessionManager = undefined;
    this.unsubscribeSession = undefined;
    this.activeToolCalls.clear();
    unsubscribe?.();

    const operation = (async (): Promise<WorkerCleanupReport> => {
      // A spawn timeout progresses cleanup but cannot certify cleanliness while
      // the exact resource/session start operation is still pending.
      await startOperation?.catch(() => undefined);
      let abort: WorkerCleanupReport["abort"] = "succeeded";
      let dispose: WorkerCleanupReport["dispose"] = "succeeded";
      const wasStreaming = Boolean(session?.isStreaming);
      let providerQuiescent = !wasStreaming;
      const details: string[] = [];
      let disposeStarted = false;
      const disposeOnce = (): void => {
        if (disposeStarted) return;
        disposeStarted = true;
        try {
          session?.dispose();
        } catch (error) {
          dispose = "failed";
          details.push(safeErrorSummary(error));
        } finally {
          this.listeners.clear();
        }
      };

      if (wasStreaming) {
        // Transform Pi's abort into an always-observed outcome. The response
        // deadline progresses disposal but never cancels or settles this one
        // authoritative cleanup operation.
        const abortOutcome = Promise.resolve().then(() => session!.abort()).then(
          () => ({ state: "succeeded" as const }),
          (error: unknown) => ({ state: "failed" as const, detail: safeErrorSummary(error) }),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadlineMs = runtimeSafeDelay(options.abortTimeoutMs);
        await Promise.race([
          abortOutcome.then(() => "abort" as const),
          new Promise<"deadline">((resolve) => { timer = setTimeout(() => resolve("deadline"), deadlineMs); }),
        ]);
        if (timer) clearTimeout(timer);
        // Exactly one disposal attempt follows the first abort-settlement or
        // deadline boundary, even while a late abort remains observed.
        disposeOnce();
        const outcome = await abortOutcome;
        abort = outcome.state;
        providerQuiescent = outcome.state === "succeeded";
        if (outcome.state === "failed") details.push(outcome.detail);
      } else disposeOnce();

      const detail = details.length > 0 ? safeErrorSummary(details.join("; ")) : undefined;
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
            ? PROCESS_QUIESCENCE_RECEIPT.detailCode
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
      activeTools: [...this.record.tools],
      isIdle: this.session?.isIdle ?? true,
      isStreaming: this.session?.isStreaming ?? false,
    };
  }

  getSessionFile(): string | undefined {
    return this.session?.sessionFile ?? this.record?.sessionFile;
  }
}
