import { existsSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import * as TypeBox from "typebox";
import { MAX_TIMER_DELAY_MS } from "./config.ts";
import { EmailProtocolError, emailErrorDetails } from "./email-error.ts";
import type {
  ActivityItem,
  AgentRecord,
  EmailEnvelope,
  SendEmailInput,
  SendEmailResult,
  WorkerCleanupReport,
  WorkerEvent,
  WorkerSnapshot,
  WorkerStartConfig,
  WorkerTransport,
} from "./types.ts";
import { formatUnanswered } from "./prompts.ts";
import { safeErrorSummary } from "./safe-summary.ts";
import { WorkerSettingsSnapshot } from "./settings-snapshot.ts";
import { textResult } from "./tool-result.ts";
import { SendEmailSchema } from "./tool-schemas.ts";
import { guardWorkerExtensionFactory, type WorkerExtensionRegistration } from "./worker-extensions.ts";
import { clone, nowIso, truncateText } from "./util.ts";
import { appendRecent, beginBatch, classifyTool, emptyWorkState, finishWorkItem, interruptActive, noteInspection, recoverMutationWork, startWorkItem, unknownWorkItem } from "./work-ledger.ts";

const { Type } = TypeBox;

export interface SendToolDetails {
  result?: SendEmailResult;
}

export interface FetchToolDetails {
  emails: EmailEnvelope[];
  total: number;
}

export function createWorkerMailTools(config: Pick<WorkerStartConfig, "sendEmail" | "fetchEmails">) {
  const send = PiCodingAgent.defineTool({
    name: "send_email",
    label: "Send email",
    description:
      "Send virtual email to another Pi agent. Sender identity is automatic. Use reply_to plus structured completion to answer. Worker-to-main new mail defaults to a notification; set requires_response only for a real request. Unknown valid recipients spawn; optional effort applies only to that initial creation.",
    promptSnippet: "Send internal mail to persistent subagents; unknown valid addresses spawn.",
    promptGuidelines: [
      "Use low-priority email by default; high is only for blockers that should change ongoing work.",
      "Answer received requests with reply_to and a structured completed, partial, or blocked completion report.",
      "Use send_email effort only on the first request that creates an unknown identity; later mail cannot mutate persisted effort.",
    ],
    executionMode: "parallel" as const,
    parameters: SendEmailSchema,
    async execute(_id, params, signal) {
      try {
        if (signal?.aborted) throw new EmailProtocolError("EMAIL_NOT_ACCEPTED", "Email send aborted before acceptance.");
        const result = await config.sendEmail(params as SendEmailInput, signal);
        const lines = [
          "Email accepted.",
          `ID: ${result.envelope.id}`,
          `To: ${result.envelope.to}`,
          `Priority: ${result.envelope.priority}`,
          `Spawned recipient: ${result.spawned ? "yes" : "no"}`,
          `Recipient disposition: ${result.recipientDisposition}`,
          `Delivery state: ${result.envelope.deliveryState}`,
          `Delivery certainty: ${result.deliveryUncertain ? `uncertain (${result.deliveryUncertain.code})` : "no post-journal uncertainty reported"}`,
          `Correlation ID: ${result.correlationId}`,
          `Reply with reply_to: ${result.expectedReplyTo ?? "none"}`,
          `Legacy expected reply subject: ${result.expectedReplySubject ?? "none"}`,
          `Answered email: ${result.answeredEmailId ?? "none"}`,
        ];
        if (result.envelope.completion) {
          lines.push(`Completion status: ${result.envelope.completion.status}`);
          if (result.envelope.completion.warning) lines.push(`Completion warning: ${result.envelope.completion.warning}`);
        }
        if (result.deliveryUncertain) lines.push(`Delivery recovery: ${result.deliveryUncertain.detail}`);
        if (result.recipientDisposition === "failed") {
          lines.push(result.recipientCleanup
            ? "Recipient recovery: mail is accepted and queued, but Pi session/tool cleanup settlement is unknown. Restart/archive are blocked only for this exact address until the live cleanup settles. Do not resend or redelegate the original scope."
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
        if (result.recipientCleanup) lines.push(`Recipient cleanup: ${result.recipientCleanup.state} · generation ${result.recipientCleanup.workerGeneration} · Pi session/tool settlement unknown`);
        return textResult(lines.join("\n"), { result } satisfies SendToolDetails);
      } catch (error) {
        const details = emailErrorDetails(error);
        if (details.code === "EMAIL_DELIVERY_FAILED" || details.code === "EMAIL_NOT_ACCEPTED") throw error;
        throw new EmailProtocolError(
          "EMAIL_NOT_ACCEPTED",
          `Email was not accepted: ${details.message}`,
          { ...details.fields, ...(details.code ? { cause_code: details.code } : {}) },
        );
      }
    },
  });

  const fetch = PiCodingAgent.defineTool({
    name: "fetch_emails",
    label: "Fetch unanswered emails",
    description:
      "Return response-required emails in your mailbox that do not yet have a successful reply. Call at the beginning of mailbox work and before stopping; answer with reply_to and structured completion.",
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

export class SdkWorker implements WorkerTransport {
  private session?: AgentSession;
  private sessionManager?: SessionManager;
  private record?: AgentRecord;
  private listeners = new Set<(event: WorkerEvent) => void>();
  private unsubscribeSession?: () => void;
  private disposed = false;
  private cleanupPromise?: Promise<WorkerCleanupReport>;
  /** Preflight boundaries for every started AgentSession.prompt operation. */
  private readonly promptAdmissions = new Set<Promise<void>>();
  /** Full accepted prompt operations, including awaited extension settlement handlers. */
  private readonly promptOperations = new Set<Promise<void>>();
  private readonly activeToolCalls = new Map<string, string>();
  private workerSettlementPending = false;
  private workerSettlementObserved = false;
  private sessionShutdownEmitted = false;
  private startGeneration = 0;
  private startOperation?: Promise<void>;
  private runFailure?: string;
  private cwd = process.cwd();

  constructor(
    private readonly modelRuntime: ModelRuntime,
    private readonly runtimeModel?: Model<any>,
    private readonly settingsSnapshot?: WorkerSettingsSnapshot,
    private readonly workerExtensions: readonly WorkerExtensionRegistration[] = [],
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

  private settleWorkerIfQuiescent(): void {
    if (
      this.disposed || !this.record || !this.workerSettlementPending || !this.workerSettlementObserved ||
      this.promptOperations.size > 0 || this.session?.isIdle === false
    ) return;
    this.workerSettlementPending = false;
    this.workerSettlementObserved = false;
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
  }

  private async emitSessionShutdown(session: AgentSession): Promise<void> {
    if (this.sessionShutdownEmitted) return;
    this.sessionShutdownEmitted = true;
    const runner = (session as AgentSession & { extensionRunner?: AgentSession["extensionRunner"] }).extensionRunner;
    if (runner?.hasHandlers("session_shutdown")) {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
    }
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
    this.record = clone(config.record);
    this.record.work ??= emptyWorkState();
    const requestedTools = [...this.record.tools];
    const enabledWorkerExtensions = this.workerExtensions.filter((registration) =>
      registration.tools.length === 0 || registration.tools.some((tool) => requestedTools.includes(tool)));
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
      extensionFactories: enabledWorkerExtensions.map((registration) => ({
        name: registration.name,
        factory: guardWorkerExtensionFactory(registration),
      })),
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

    const workerTools = [...requestedTools];
    const { session, extensionsResult } = await PiCodingAgent.createAgentSession({
      cwd: config.cwd,
      agentDir: config.agentDir,
      modelRuntime: this.modelRuntime,
      model: this.runtimeModel ?? config.model,
      thinkingLevel: this.record.effort,
      tools: workerTools,
      customTools: [...createWorkerMailTools(config)],
      resourceLoader: loader,
      sessionManager,
      settingsManager: settings,
      sessionStartEvent: { type: "session_start", reason: resumableSessionFile ? "resume" : "new" },
    });
    if (extensionsResult.errors.length > 0) {
      session.dispose();
      throw new Error("A registered worker extension failed to load.");
    }
    for (const registration of enabledWorkerExtensions) {
      const extension = extensionsResult.extensions.find((candidate) => candidate.path === `<inline:${registration.name}>`);
      const registeredTools = extension ? [...extension.tools.keys()] : [];
      if (!extension || registeredTools.length !== registration.tools.length || registeredTools.some((tool) => !registration.tools.includes(tool))) {
        session.dispose();
        throw new Error(`Worker extension ${registration.name} did not register exactly its declared tools.`);
      }
    }
    const shutdownAndDisposeBoundSession = async (): Promise<void> => {
      await this.emitSessionShutdown(session).catch(() => undefined);
      if (session.isCompacting) session.abortCompaction();
      if (session.isStreaming) await session.abort().catch(() => undefined);
      session.dispose();
    };
    try {
      await session.bindExtensions({
        mode: "print",
        onError: () => this.activity("error", "A registered worker extension reported an error."),
      });
    } catch (error) {
      await shutdownAndDisposeBoundSession();
      throw error;
    }
    if (this.disposed || generation !== this.startGeneration) {
      await shutdownAndDisposeBoundSession();
      throw new Error("Worker start was cancelled.");
    }
    for (const registration of enabledWorkerExtensions) {
      const extension = extensionsResult.extensions.find((candidate) => candidate.path === `<inline:${registration.name}>`);
      const registeredTools = extension ? [...extension.tools.keys()] : [];
      if (!extension || registeredTools.length !== registration.tools.length || registeredTools.some((tool) => !registration.tools.includes(tool))) {
        await shutdownAndDisposeBoundSession();
        throw new Error(`Worker extension ${registration.name} changed its declared tools during session startup.`);
      }
    }
    const activeTools = session.getActiveToolNames();
    for (const registration of enabledWorkerExtensions) {
      const missing = registration.tools.filter((tool) => requestedTools.includes(tool) && !activeTools.includes(tool));
      if (missing.length > 0) {
        await shutdownAndDisposeBoundSession();
        throw new Error(`Worker extension ${registration.name} did not activate its declared tool ${missing[0]}.`);
      }
    }
    this.record.sessionFile = session.sessionFile;
    this.record.effort = session.thinkingLevel;
    this.record.tools = activeTools;
    if (!this.record.tools.includes("send_email") || !this.record.tools.includes("fetch_emails")) {
      await shutdownAndDisposeBoundSession();
      throw new Error("Worker mailbox tools were not activated.");
    }
    this.session = session;
    this.unsubscribeSession = session.subscribe((event) => this.onSessionEvent(event));
    this.setState("idle");
    const unknownTools = requestedTools.filter((tool) => !this.record!.tools.includes(tool));
    if (unknownTools.length > 0) this.activity("error", `Unknown tools omitted: ${unknownTools.join(", ")}`);
    this.activity("status", this.record.sessionFile ? "Session ready" : "Session ready in memory");
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    if (!this.record) return;
    // After routing detaches, retain only content-free tool settlement facts
    // until AgentSession.abort() reaches its idle boundary. No stale session
    // event may otherwise mutate or publish worker state during cleanup.
    if (this.disposed) {
      if (event.type === "tool_execution_start") this.activeToolCalls.set(event.toolCallId, event.toolName);
      else if (event.type === "tool_execution_end") this.activeToolCalls.delete(event.toolCallId);
      return;
    }
    switch (event.type) {
      case "agent_start":
        if (!this.workerSettlementPending) this.runFailure = undefined;
        this.workerSettlementPending = true;
        this.workerSettlementObserved = false;
        this.emit({ type: "run_liveness", phase: "model_start" });
        this.setState("running");
        this.activity("status", "Agent run started");
        break;
      case "tool_execution_start": {
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
        } else {
          this.runFailure = undefined;
        }
        break;
      }
      case "agent_settled":
        this.workerSettlementObserved = true;
        this.settleWorkerIfQuiescent();
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
    let admissionFinished = false;
    let finishAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      finishAdmission = () => {
        if (admissionFinished) return;
        admissionFinished = true;
        this.promptAdmissions.delete(admission);
        resolve();
      };
    });
    this.promptAdmissions.add(admission);
    const finishAfterPiLeavesCallback = (): void => { queueMicrotask(finishAdmission); };
    try {
      await awaitPromptAcceptance(
        (preflightResult) => {
          const operation = session.prompt(message, {
            source: "extension",
            expandPromptTemplates: false,
            preflightResult: (success) => {
              try {
                const vetoInvalidAdmission = (): void => {
                  if (!this.disposed && this.session === session) return;
                  preflightResult(false);
                  // Pi 0.84.2 invokes this callback synchronously immediately
                  // before _runAgentPrompt. Throwing is the admission veto that
                  // prevents a late old-generation model run from starting.
                  throw new Error("Worker prompt was cancelled by cleanup before Pi preflight admission.");
                };
                if (success) vetoInvalidAdmission();
                if (success && startsBatch) this.sessionManager?.appendCustomEntry("pi-email-subagent-work-batch", {
                  batchId,
                  startedAt: this.record!.work!.batchStartedAt,
                });
                // Keep the actual Pi acceptance call as the final guarded
                // action even if a synchronous session entry hook re-entered
                // cleanup while the batch marker was appended.
                if (success) vetoInvalidAdmission();
                preflightResult(success);
              } finally {
                // For accepted prompts Pi starts _runAgentPrompt immediately
                // after this callback returns. Settle on the following
                // microtask so cleanup observes either that run or the veto.
                finishAfterPiLeavesCallback();
              }
            },
          });
          this.promptOperations.add(operation);
          const finishOperation = (): void => {
            this.promptOperations.delete(operation);
            this.settleWorkerIfQuiescent();
          };
          operation.then(finishOperation, finishOperation);
          operation.then(finishAdmission, finishAdmission);
          return operation;
        },
        (error) => {
          if (this.disposed) return;
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
      if (this.session?.isCompacting) this.session.abortCompaction();
      if (this.session?.isStreaming) await this.session.abort();
    } finally {
      if (this.record?.work) interruptActive(this.record.work);
      this.setState("stopped");
    }
  }

  cleanup(): Promise<WorkerCleanupReport> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.disposed = true;
    this.startGeneration += 1;
    const session = this.session;
    const unsubscribe = this.unsubscribeSession;
    const startOperation = this.startOperation;
    const promptAdmissions = [...this.promptAdmissions];

    const operation = (async (): Promise<WorkerCleanupReport> => {
      // Factory/start ownership and every already-started Pi prompt preflight
      // are part of this exact worker lease. A caller deadline never settles
      // or cancels either underlying operation.
      await startOperation?.catch(() => undefined);
      await Promise.allSettled(promptAdmissions);
      const activeToolsAtStart = new Map(this.activeToolCalls);
      if (this.session === session) this.session = undefined;
      this.sessionManager = undefined;
      if (this.unsubscribeSession === unsubscribe) this.unsubscribeSession = undefined;
      let abort: WorkerCleanupReport["abort"] = "succeeded";
      let dispose: WorkerCleanupReport["dispose"] = "succeeded";
      const details: string[] = [];

      if (session) {
        try {
          await this.emitSessionShutdown(session);
        } catch (error) {
          abort = "failed";
          details.push(`session shutdown: ${safeErrorSummary(error)}`);
        }
      }
      let compactionAbortAttempted = false;
      let streamingAbortAttempted = false;
      const quiescent = (): boolean => !session
        ? this.promptOperations.size === 0 && this.activeToolCalls.size === 0
        : session.isIdle !== false
          && !session.isCompacting
          && !session.isStreaming
          && this.promptOperations.size === 0
          && this.activeToolCalls.size === 0;
      while (!quiescent()) {
        if (session?.isCompacting && !compactionAbortAttempted) {
          compactionAbortAttempted = true;
          try {
            session.abortCompaction();
          } catch (error) {
            abort = "failed";
            details.push(safeErrorSummary(error));
          }
        }
        if (session?.isStreaming && !streamingAbortAttempted) {
          streamingAbortAttempted = true;
          const outcome = await Promise.resolve().then(() => session.abort()).then(
            () => ({ state: "succeeded" as const }),
            (error: unknown) => ({ state: "failed" as const, detail: safeErrorSummary(error) }),
          );
          if (outcome.state === "failed") {
            abort = "failed";
            details.push(outcome.detail);
          }
        }
        await Promise.allSettled([...this.promptOperations]);
        if (quiescent()) break;
        // The broker's cleanup deadline quarantines this address; it does not
        // cancel this authoritative observation. Poll slowly until Pi reaches
        // its real idle/compaction/tool boundary, however long that takes.
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        if (!session?.isCompacting) compactionAbortAttempted = false;
        if (!session?.isStreaming) streamingAbortAttempted = false;
      }
      const sessionIdle = quiescent();

      // Disposal follows, and never bypasses, the real prompt/compaction/tool/idle boundary.
      try {
        session?.dispose();
      } catch (error) {
        dispose = "failed";
        details.push(safeErrorSummary(error));
      } finally {
        unsubscribe?.();
        this.listeners.clear();
      }

      const tools = [...activeToolsAtStart].map(([toolCallId, toolName]) => {
        const settled = !this.activeToolCalls.has(toolCallId);
        return {
          toolCallId,
          toolName,
          quiescence: settled ? "verified" as const : "unknown" as const,
          ...(settled ? {} : { detailCode: "PI_TOOL_STILL_ACTIVE_AFTER_SESSION_ABORT" }),
        };
      });
      for (const [toolCallId, toolName] of this.activeToolCalls) {
        if (activeToolsAtStart.has(toolCallId)) continue;
        tools.push({
          toolCallId,
          toolName,
          quiescence: "unknown",
          detailCode: "PI_TOOL_STILL_ACTIVE_AFTER_SESSION_ABORT",
        });
      }
      this.activeToolCalls.clear();
      const quiescence = sessionIdle
        && abort === "succeeded"
        && dispose === "succeeded"
        && tools.every((tool) => tool.quiescence === "verified")
        ? "verified" as const
        : "unknown" as const;
      const detail = details.length > 0 ? safeErrorSummary(details.join("; ")) : undefined;
      return {
        sessionDisposed: dispose === "succeeded",
        sessionIdle,
        tools,
        quiescence,
        source: quiescence === "verified"
          ? "pi-agent-session-and-tools-settled"
          : "pi-agent-session-or-tools-unsettled",
        abort,
        dispose,
        ...(detail ? { detail } : {}),
      };
    })();
    this.cleanupPromise = operation;
    return operation;
  }

  async dispose(): Promise<void> {
    const report = await this.cleanup();
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
