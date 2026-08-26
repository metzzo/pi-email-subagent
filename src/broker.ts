import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  AddressError,
  ModelCatalog,
  parseBoundSubagentAddress,
  parseLegacySubagentAddress,
  parseNewSubagentAddress,
  parseSubagentAddressShape,
} from "./address.ts";
import { transitionAbandonedOwnerRecovery } from "./abandoned-owner-recovery.ts";
import { isConfiguredWritable, isConservativeCleanupCapable } from "./capability.ts";
import {
  isSafeConfigSemanticText,
  isThinkingLevel,
  MAX_CONFIG_PROFILE_TOOLS,
  MAX_CONFIG_TOOL_NAME_BYTES,
  MAX_TIMER_DELAY_MS,
  resolveAgentProfile,
  resolveLifecycle,
} from "./config.ts";
import { createMailId } from "./id.ts";
import { MailStore } from "./mail-store.ts";
import { ProviderReadinessError } from "./model-runtime.ts";
import { NamespaceLock } from "./namespace-lock.ts";
import { enforcementPrompt, formatEmail, formatEmailBatch, subagentPrompt } from "./prompts.ts";
import { RegistryStore } from "./registry-store.ts";
import { looksLikeReply, makeReplySubject, parseReplySubject } from "./reply.ts";
import { SlidingWindowRateLimiter } from "./rate-limit.ts";
import { safeErrorSummary } from "./safe-summary.ts";
import { deadlineSignal, lifecycleDuration, runtimeSafeDelay, type DeadlineSignal } from "./runtime-timers.ts";
import { MAIL_TOOL_BATCH_BYTES, MAIL_TOOL_BATCH_LINES } from "./tool-result.ts";
import type {
  AgentArchiveBlockers,
  AgentCapacitySnapshot,
  AgentInspection,
  AgentRecord,
  CleanupDiagnostic,
  BrokerOptions,
  BrokerRegistry,
  BrokerSnapshot,
  EmailEnvelope,
  ParsedAddress,
  ReplyWaitItem,
  SendEmailInput,
  SendEmailResult,
  LifecyclePolicy,
  ModelBinding,
  WaitForRepliesResult,
  WorkerCleanupReport,
  WorkerEvent,
  WorkerRunLivenessEvent,
  WorkerToolLifecycleEvent,
  WorkerTransport,
  WorkItem,
  AgentWorkState,
} from "./types.ts";
import { byteLength, clone, nowIso, truncateText } from "./util.ts";
import { currentBatchHasEffectfulWork, emptyWorkState, interruptActive, recoverMutationWork } from "./work-ledger.ts";

export const MAX_CANCELLATION_REASON_BYTES = 1_024;

/** Conservative byte budget: reserve declared output and 75% of remaining context for system/history/token-estimation error. */
export function conservativeModelEnvelopeBudget(model: { contextWindow: number; maxTokens: number }): number {
  if (!Number.isSafeInteger(model.contextWindow) || !Number.isSafeInteger(model.maxTokens)
    || model.contextWindow <= 0 || model.maxTokens < 0 || model.maxTokens >= model.contextWindow) return 0;
  return Math.floor((model.contextWindow - model.maxTokens) / 4);
}
const ARCHIVE_BLOCKER_ID_LIMIT = 5;
const MAX_WORKER_EPOCH_TOOLS = MAX_CONFIG_PROFILE_TOOLS;

// Every caught lifecycle/provider/session error uses the shared content-safe
// boundary before it can enter mail, registry, UI, or a main notification.
const errorMessage = safeErrorSummary;

function emptyUsage(): AgentRecord["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function lightweightWorkItem(item: WorkItem): WorkItem {
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(item)) {
    if (key === "patchPreview") continue;
    projected[key] = clone((item as unknown as Record<string, unknown>)[key]);
  }
  if (Object.prototype.hasOwnProperty.call(item, "patchPreview")) projected.patchAvailable = true;
  return projected as unknown as WorkItem;
}

function sanitizePersistedRecordErrors(record: AgentRecord): void {
  if (record.failure) record.failure = safeErrorSummary(record.failure);
  if (record.cleanup?.detail) record.cleanup.detail = safeErrorSummary(record.cleanup.detail);
  if (record.work?.recoveryError) record.work.recoveryError = safeErrorSummary(record.work.recoveryError);
  for (const item of [...(record.work?.active ?? []), ...(record.work?.recent ?? [])]) {
    if (item.error) item.error = safeErrorSummary(item.error);
  }
  let currentIndex = -1;
  for (let index = record.activity.length - 1; index >= 0; index -= 1) {
    if (record.activity[index]?.summary === record.currentActivity) { currentIndex = index; break; }
  }
  record.activity = record.activity.map((item) => ({
    ...item,
    summary: item.kind === "error" || item.kind === "status"
      ? safeErrorSummary(item.summary)
      : item.summary,
  }));
  if (currentIndex >= 0) record.currentActivity = record.activity[currentIndex]?.summary;
  else if (record.state === "failed" && record.currentActivity) record.currentActivity = safeErrorSummary(record.currentActivity);
}

function lightweightWork(work: AgentWorkState): AgentWorkState {
  return {
    nextBatchId: work.nextBatchId,
    ...(work.currentBatchId !== undefined ? { currentBatchId: work.currentBatchId } : {}),
    ...(work.batchStartedAt !== undefined ? { batchStartedAt: work.batchStartedAt } : {}),
    ...(work.batchEndedAt !== undefined ? { batchEndedAt: work.batchEndedAt } : {}),
    ...(work.recoveryError !== undefined ? { recoveryError: work.recoveryError } : {}),
    ...(work.effectEvidenceUnavailable ? { effectEvidenceUnavailable: true } : {}),
    active: work.active.map(lightweightWorkItem),
    recent: work.recent.map(lightweightWorkItem),
    inspection: { ...work.inspection },
  };
}

// Generous upper bound for the `Re: [<mail-id>] ` prefix added to reply subjects.
const REPLY_PREFIX_ALLOWANCE_BYTES = 64;

function swallow(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

class CleanupQuarantineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupQuarantineError";
  }
}

class LifecycleTimeoutError extends Error {
  constructor(readonly code: string, readonly timeoutMs: number, detail?: string) {
    super(`${code}: lifecycle deadline exceeded after ${timeoutMs}ms${detail ? ` (${detail})` : ""}`);
    this.name = "LifecycleTimeoutError";
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  const deadline = deadlineSignal(timeoutMs);
  try {
    return await Promise.race([
      promise,
      deadline.promise.then<never>(() => { throw new LifecycleTimeoutError(code, timeoutMs); }),
    ]);
  } finally {
    deadline.cancel();
    promise.catch(() => undefined);
  }
}

function containsLifecycleTimeout(error: unknown): boolean {
  if (error instanceof LifecycleTimeoutError) return true;
  return error instanceof AggregateError && error.errors.some(containsLifecycleTimeout);
}

function containsCleanupQuarantine(error: unknown): boolean {
  if (error instanceof CleanupQuarantineError) return true;
  return error instanceof AggregateError && error.errors.some(containsCleanupQuarantine);
}

interface WatchdogEntry {
  generation: number;
  worker: WorkerTransport;
  startedAt: number;
  lastIdleAt: number;
  idleGeneration: number;
  run?: ReturnType<typeof setTimeout>;
  idle?: ReturnType<typeof setTimeout>;
}

interface RetryLivenessHold {
  deadline: number;
  timer?: DeadlineSignal;
}

interface RunLivenessState {
  worker: WorkerTransport;
  watchdogGeneration?: number;
  modelPhase?: "started" | "progress" | "ended";
  lastPulseAt?: number;
  retry?: RetryLivenessHold;
}

interface WorkerCleanupLease {
  address: string;
  worker: WorkerTransport;
  workerGeneration: number;
  reasonCode: string;
  startedAt: string;
  activeToolsAtStart: ReadonlyArray<{ toolCallId: string; toolName: string }>;
  heldRunSlot: boolean;
  mutationCapable: boolean;
  targetState: "failed" | "stopped" | "paused" | "archived";
  alerted: boolean;
  operationSettled: boolean;
  operation: Promise<WorkerCleanupReport>;
  settled: Promise<WorkerCleanupReport>;
}

interface PendingFactoryLease {
  address: string;
  workerGeneration: number;
  factory: Promise<WorkerTransport>;
}

interface SettlementLease {
  address: string;
  worker: WorkerTransport;
  workerGeneration: number;
  invalidated: boolean;
  pending: boolean;
  operation: Promise<void>;
}

interface ActiveToolCall {
  toolName: string;
}

interface ToolLifecycleState {
  worker: WorkerTransport;
  watchdogGeneration?: number;
  calls: Map<string, ActiveToolCall>;
}

function sortMail(emails: EmailEnvelope[]): EmailEnvelope[] {
  return emails.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export class AgentBroker {
  readonly mailStore: MailStore;
  readonly registryStore: RegistryStore;
  readonly catalog: ModelCatalog;

  private registry?: BrokerRegistry;
  private readonly records = new Map<string, AgentRecord>();
  private readonly routableRecords = new Set<string>();
  private readonly workers = new Map<string, WorkerTransport>();
  private readonly workerUnsubscribers = new Map<string, () => void>();
  private readonly provisionalWorkers = new Set<WorkerTransport>();
  /** Exact pre-email runtime preparation retained until this process creates the bound worker. */
  private readonly preparedWorkerRuntimes = new Map<string, unknown>();
  private readonly workerGenerations = new WeakMap<WorkerTransport, number>();
  private readonly workerAddresses = new WeakMap<WorkerTransport, string>();
  private readonly cleanupLeases = new Map<WorkerTransport, WorkerCleanupLease>();
  private readonly cleanupQuarantines = new Map<string, WorkerCleanupLease>();
  private readonly pendingFactories = new Map<string, PendingFactoryLease>();
  private nextWorkerGeneration = 0;
  private readonly addressTails = new Map<string, Promise<void>>();
  /** Child-reply prompt acceptance may let Pi issue tools before its answer commit; upstream admission joins that exact transition. */
  private readonly dependencyDeliveryTransitions = new Map<string, Promise<void>>();
  private mailAdmissionTail: Promise<void> = Promise.resolve();
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private readonly operationLabels = new WeakMap<Promise<unknown>, string>();
  private readonly activationLeases = new Set<string>();
  private readonly active = new Set<string>();
  private readonly pendingStarts: string[] = [];
  private readonly pendingAdmissions = new Set<string>();
  private readonly scheduling = new Set<string>();
  private readonly settlements = new Map<WorkerTransport, SettlementLease>();
  private readonly globalRateLimiter: SlidingWindowRateLimiter;
  private readonly senderRateLimiters = new Map<string, SlidingWindowRateLimiter>();
  private readonly changeListeners = new Set<() => void>();
  private readonly collectingRequestIds = new Map<string, number>();
  private readonly collectionClaims = new Map<string, number>();
  private readonly pendingWorkPersists = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchdogs = new Map<string, WatchdogEntry>();
  private readonly toolLifecycles = new Map<string, ToolLifecycleState>();
  private readonly runLifecycles = new Map<string, RunLivenessState>();
  private watchdogGeneration = 0;
  private lifecycle: "new" | "initializing" | "active" | "closing" | "closed" = "new";
  private lifecycleGeneration = 0;
  private initPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private namespaceLock?: NamespaceLock;
  private disposed = false;
  private mainRouting: { address: string; preferredProvider?: string };

  constructor(private readonly options: BrokerOptions) {
    this.mailStore = new MailStore(join(options.namespaceDir, "mail.jsonl"));
    this.registryStore = new RegistryStore(join(options.namespaceDir, "registry.json"));
    this.catalog = new ModelCatalog(options.models);
    this.mainRouting = {
      address: options.mainAdapter.getAddress().toLowerCase(),
      ...(options.preferredProvider ? { preferredProvider: options.preferredProvider } : {}),
    };
    this.globalRateLimiter = new SlidingWindowRateLimiter(options.config.maxMailsPerMinute);
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    if (this.lifecycle !== "new") throw new Error(`Email broker cannot initialize from ${this.lifecycle}.`);
    this.lifecycle = "initializing";
    const generation = ++this.lifecycleGeneration;
    const operation = this.initialize(generation);
    this.initPromise = operation;
    return operation;
  }

  private cancelled(generation: number): boolean {
    return generation !== this.lifecycleGeneration || this.lifecycle === "closing" || this.lifecycle === "closed";
  }

  private checkpoint(generation: number): void {
    if (this.cancelled(generation)) throw new Error("Email broker initialization was cancelled by shutdown.");
  }

  private async initialize(generation: number): Promise<void> {
    try {
      this.namespaceLock = await NamespaceLock.acquire(this.options.namespaceDir, (error) => {
        this.options.mainAdapter.notifyFailure(`Subagent namespace lock was compromised: ${errorMessage(error)}`);
        swallow(this.shutdown());
      });
      this.checkpoint(generation);
      await this.mailStore.init();
      this.checkpoint(generation);
      await this.mailStore.maintainIfNeeded(undefined, this.options.config.maxRetainedEmails);
      this.checkpoint(generation);
      const currentMain = this.options.mainAdapter.getAddress().toLowerCase();
      this.mainRouting = { address: currentMain, ...(this.mainRouting.preferredProvider ? { preferredProvider: this.mainRouting.preferredProvider } : {}) };
      this.registry = await this.registryStore.load(currentMain);
      this.checkpoint(generation);
      this.registry.mainAddress = currentMain;
      this.registry.mainAliases = [...new Set([
        ...this.registry.mainAliases.map((value) => value.toLowerCase()),
        ...this.options.mainAdapter.getAliases(),
        currentMain,
      ])];

      this.nextWorkerGeneration = this.registry.agents.reduce((maximum, record) => Math.max(
        maximum,
        record.workerEpoch?.generation ?? 0,
        record.cleanup?.workerGeneration ?? 0,
      ), this.nextWorkerGeneration);
      const startupFailures: string[] = [];
      for (const loaded of this.registry.agents) {
        const shape = parseSubagentAddressShape(loaded.address);
        let record = clone(loaded);
        sanitizePersistedRecordErrors(record);
        record.address = shape.address;
        if (this.namespaceLock.abandonedOwner) {
          record = transitionAbandonedOwnerRecovery(record).record;
        }
        record.name = shape.name;
        record.taskSlug = shape.taskSlug;
        try {
          let parsed: ParsedAddress;
          if (record.provider === "unavailable") {
            parsed = parseLegacySubagentAddress(shape.address, this.catalog);
            record.provider = parsed.model.provider;
            record.modelId = parsed.model.id;
            const summary = `Legacy provider binding uniquely migrated to ${record.provider}/${record.modelId}; no main-provider preference was used.`;
            record.activity.push({ at: nowIso(), kind: "status", summary });
            record.activity = record.activity.slice(-40);
            record.currentActivity = summary;
          } else {
            parsed = this.resolveExistingRecord(record);
          }
          const profile = resolveAgentProfile(this.options.config, record.address, record.name);
          record.tools = profile.tools;
          // Nested response-required admission is unavailable until Pi exposes
          // a recoverable durable child-reply presentation receipt.
          record.canSpawn = false;
          record.instructions = profile.instructions;
          if (["running", "spawning", "queued"].includes(record.state)) record.state = "paused";
          if (record.failure?.startsWith("Model unavailable during restore:") && !record.cleanup) {
            record.state = "failed";
            record.failure = `Exact binding ${record.provider}/${record.modelId} is available again; explicit same-identity restart is required before queued mail can be delivered.`;
            record.currentActivity = record.failure;
            startupFailures.push(`${record.address}: ${record.failure}`);
          }
          if (record.state !== "running") this.interruptRecordWork(record);
          this.routableRecords.add(record.address);
        } catch (error) {
          // The exact runtime binding is unavailable, so preserve the loaded
          // durable profile rather than partially reconfiguring this identity.
          const priorState = record.state;
          if (priorState !== "archived" && priorState !== "stopped") record.state = "failed";
          record.failure = truncateText(`Model unavailable during restore: ${errorMessage(error)}`, 1_500);
          record.currentActivity = record.failure;
          record.updatedAt = nowIso();
          if (priorState !== "archived") startupFailures.push(`${record.address}: ${record.failure}`);
        }
        if (record.cleanup) startupFailures.push(`${record.address}: Pi session/tool cleanup settlement unknown; exact-address restoration blocked.`);
        this.records.set(record.address, record);
      }

      // Mail acceptance precedes first worker persistence. Recover a recipient
      // record when a crash leaves durable queued mail but no registry entry.
      for (const email of this.mailStore.list()) {
        if (email.deliveryState !== "queued" || this.isMainIdentity(email.to) || this.records.has(email.to)) continue;
        const shape = parseSubagentAddressShape(email.to);
        try {
          const parsed = email.modelBindingIntent
            ? parseBoundSubagentAddress(shape.address, this.catalog, email.modelBindingIntent)
            : parseLegacySubagentAddress(shape.address, this.catalog);
          const record = this.makeRecord(
            parsed,
            email.lifecycleIntent ?? resolveLifecycle(this.options.config, parsed.address, parsed.name),
            email.effortIntent,
          );
          record.createdAt = email.createdAt;
          record.updatedAt = nowIso();
          record.state = "paused";
          if (!email.modelBindingIntent) {
            const summary = `Legacy provider binding uniquely migrated to ${record.provider}/${record.modelId}; no main-provider preference was used.`;
            record.activity.push({ at: nowIso(), kind: "status", summary });
            record.currentActivity = summary;
          }
          this.records.set(record.address, record);
          this.routableRecords.add(record.address);
        } catch (error) {
          const profile = resolveAgentProfile(this.options.config, shape.address, shape.name);
          const record = this.makeUnavailableRecord(
            shape,
            email.createdAt,
            errorMessage(error),
            email.modelBindingIntent,
            email.lifecycleIntent,
            email.effortIntent,
          );
          record.tools = profile.tools;
          record.canSpawn = false;
          record.instructions = profile.instructions;
          this.records.set(record.address, record);
          startupFailures.push(`${record.address}: ${record.failure}`);
        }
      }

      // A crash between administrative child cancellation and parent wake
      // synthesis is recovered from the canonical cancelled journal entry.
      for (const request of this.mailStore.list()) {
        if (request.kind === "request" && request.deliveryState === "cancelled" && !this.isMainIdentity(request.from)) {
          await this.ensureCancellationWakeJournal(request);
        }
      }

      // Recover durable mutation outcomes before provider startup or capacity filtering.
      for (const record of this.records.values()) {
        if (!record.sessionFile) { this.interruptRecordWork(record); continue; }
        try {
          const info = await stat(record.sessionFile);
          if (info.size > 20 * 1024 * 1024) throw new Error("session exceeds 20 MB recovery bound");
          const manager = PiCodingAgent.SessionManager.open(record.sessionFile, join(this.options.namespaceDir, "sessions"), this.options.cwd);
          record.work = recoverMutationWork(manager.getBranch(), this.options.cwd, record.work ?? emptyWorkState());
        } catch (error) {
          record.work ??= emptyWorkState();
          this.interruptRecordWork(record);
          record.work.effectEvidenceUnavailable = true;
          record.work.recoveryError = truncateText(errorMessage(error), 500);
        }
      }

      const registered = [...this.records.values()].filter((record) =>
        record.state !== "archived" && this.routableRecords.has(record.address));
      // Reconstruct exact-address cleanup leases before admitting ordinary
      // identities. Only genuinely unresolved cleanup can retain a run slot;
      // an exact dead-owner normalization clears dead in-process slot claims.
      for (const record of this.records.values()) {
        if (!record.cleanup || record.state === "archived") continue;
        this.activationLeases.add(record.address);
        if (record.cleanup.heldRunSlot) this.active.add(record.address);
      }
      const ordinaryCapacity = Math.max(0, this.options.config.maxAgents - this.activationLeases.size);
      const ordinary = registered.filter((record) => !record.cleanup);
      for (const record of ordinary.slice(0, ordinaryCapacity)) this.activationLeases.add(record.address);
      for (const record of ordinary.slice(ordinaryCapacity)) {
        this.interruptRecordWork(record);
        // Capacity filtering must not rewrite durable terminal lifecycle facts.
        // A stopped or failed identity can reacquire its lease only through its
        // existing explicit recovery path after capacity becomes available.
        if (record.state !== "stopped" && record.state !== "failed") {
          record.state = "paused";
          record.currentActivity = `Paused by maxAgents capacity (${this.options.config.maxAgents})`;
          record.updatedAt = nowIso();
        }
      }
      await this.persistRegistry(true);
      this.checkpoint(generation);

      const restorable = [...this.records.values()]
        .filter((record) => this.activationLeases.has(record.address)
          && !["stopped", "failed", "archived"].includes(record.state));
      const restored = await Promise.allSettled(restorable.map(async (record) => {
        try {
          const parsed = this.resolveExistingRecord(record);
          await this.createWorker(parsed, record, generation);
        } catch (error) {
          if (this.cancelled(generation)) return;
          record.state = "failed";
          record.failure = `Restore failed: ${errorMessage(error)}`;
          record.updatedAt = nowIso();
        }
      }));
      void restored;
      this.checkpoint(generation);
      await this.persistRegistry(true);
      this.checkpoint(generation);
      this.lifecycle = "active";
      await this.restoreQueuedMainMail(generation);
      this.checkpoint(generation);
      for (const record of this.records.values()) {
        if (record.state === "failed") await this.ensureTerminalChildBlockers(record);
      }

      for (const record of this.records.values()) {
        if (!this.workers.has(record.address)) continue;
        if (this.queuedDependencyReplies(record.address).length > 0) swallow(this.trackInFlight(this.schedule(record.address), `schedule:${record.address}`));
        else if (this.outgoingDependencies(record.address).length > 0) await this.parkWorker(record.address, record);
        else if (this.mailStore.unanswered(record.address).length > 0) swallow(this.trackInFlight(this.resumeEnforcement(record.address), `enforcement:${record.address}`));
        else if (this.mailStore.queued(record.address).length > 0) swallow(this.trackInFlight(this.schedule(record.address), `schedule:${record.address}`));
        else {
          record.state = "idle";
          record.updatedAt = nowIso();
        }
      }
      this.publish();
      for (const failure of startupFailures) this.options.mainAdapter.notifyFailure(failure);
      this.scheduleMailMaintenance();
    } catch (error) {
      const cancelled = this.cancelled(generation);
      if (!cancelled) {
        this.lifecycle = "closing";
        this.disposed = true;
        this.lifecycleGeneration += 1;
      }
      let cleanupError: unknown;
      try { await this.disposeOwnedWorkers(); } catch (cleanupFailure) { cleanupError = cleanupFailure; }
      let releaseError: unknown;
      if (!cancelled && !cleanupError) {
        try { await this.releaseNamespaceLock(); } catch (lockError) { releaseError = lockError; }
        this.lifecycle = "closed";
      }
      if (cleanupError || releaseError) {
        throw new AggregateError(
          [error, ...(cleanupError ? [cleanupError] : []), ...(releaseError ? [releaseError] : [])],
          `Broker initialization failed and cleanup could not prove safe namespace release.`,
        );
      }
      throw error;
    }
  }

  private interruptRecordWork(record: AgentRecord): void {
    if (record.work?.active.length) interruptActive(record.work);
  }

  private capabilityTools(tools: readonly string[]): string[] {
    const unique = [...new Set(tools)];
    if (unique.length > MAX_WORKER_EPOCH_TOOLS
      || unique.some((tool) => !tool
        || byteLength(tool) > MAX_CONFIG_TOOL_NAME_BYTES
        || !isSafeConfigSemanticText(tool, false))) {
      throw new Error(`Worker capability exceeds ${MAX_WORKER_EPOCH_TOOLS} tools or the ${MAX_CONFIG_TOOL_NAME_BYTES}-UTF-8-byte safe name bound.`);
    }
    return unique;
  }

  private isToolSetMutationCapable(tools: readonly string[]): boolean {
    return isConservativeCleanupCapable(tools);
  }

  private cleanupError(address: string): CleanupQuarantineError {
    return new CleanupQuarantineError(
      `${address} Pi session/tool cleanup settlement is unknown; the exact address remains quarantined and queued mail is preserved. Unrelated addresses are not blocked.`,
    );
  }

  private assertNoCleanupQuarantine(address: string): void {
    if (this.pendingFactories.has(address)
      || this.cleanupQuarantines.has(address)
      || this.records.get(address)?.cleanup) throw this.cleanupError(address);
  }

  private exactWorkerAdmissionCurrent(address: string, record: AgentRecord, worker: WorkerTransport): boolean {
    return !this.disposed
      && this.records.get(address) === record
      && this.workers.get(address) === worker
      && !record.cleanup
      && !this.cleanupQuarantines.has(address)
      && !this.pendingFactories.has(address);
  }

  private workerGeneration(worker: WorkerTransport, address: string, assignedGeneration?: number): number {
    let generation = this.workerGenerations.get(worker);
    if (!generation) {
      generation = assignedGeneration ?? ++this.nextWorkerGeneration;
      this.nextWorkerGeneration = Math.max(this.nextWorkerGeneration, generation);
      this.workerGenerations.set(worker, generation);
      this.workerAddresses.set(worker, address);
    } else if (assignedGeneration !== undefined && generation !== assignedGeneration) {
      throw new Error(`Worker generation assignment changed for ${address}.`);
    }
    return generation;
  }

  private cleanupDiagnostic(lease: WorkerCleanupLease): CleanupDiagnostic {
    return {
      state: "pending",
      reasonCode: truncateText(lease.reasonCode.replace(/\s+/g, " "), 100),
      workerGeneration: lease.workerGeneration,
      startedAt: lease.startedAt,
      updatedAt: lease.startedAt,
      abort: "pending",
      dispose: "pending",
      quiescence: "unknown",
      mutationCapableAtStart: lease.mutationCapable,
      heldRunSlot: lease.heldRunSlot,
      activeTools: lease.activeToolsAtStart.map((tool) => ({ ...tool })),
    };
  }

  private beginWorkerCleanup(
    address: string,
    worker: WorkerTransport,
    reasonCode: string,
    targetState: WorkerCleanupLease["targetState"],
  ): WorkerCleanupLease {
    const existing = this.cleanupLeases.get(worker);
    if (existing) return existing;
    const addressLease = this.cleanupQuarantines.get(address);
    if (addressLease && addressLease.worker !== worker) throw this.cleanupError(address);
    const record = this.records.get(address);
    const tools = this.toolLifecycles.get(address);
    const activeToolsAtStart = tools?.worker === worker
      ? [...tools.calls].slice(0, 64).map(([toolCallId, call]) => ({
        toolCallId: truncateText(toolCallId.replace(/\s+/g, " "), 200),
        toolName: truncateText(call.toolName.replace(/\s+/g, " "), 100),
      }))
      : [];
    const workerGeneration = this.workerGeneration(worker, address);
    const exactEpoch = record?.workerEpoch?.generation === workerGeneration
      ? record.workerEpoch
      : undefined;
    const lease: WorkerCleanupLease = {
      address,
      worker,
      workerGeneration,
      reasonCode,
      startedAt: nowIso(),
      activeToolsAtStart,
      heldRunSlot: exactEpoch?.runSlotHeld ?? this.active.has(address),
      mutationCapable: exactEpoch?.mutationCapable ?? true,
      targetState,
      alerted: false,
      operationSettled: false,
      operation: undefined as never,
      settled: undefined as never,
    };

    this.invalidateSettlement(worker);
    this.clearWatchdog(address);
    this.clearToolLifecycle(address, worker);
    if (this.workers.get(address) === worker) {
      this.workerUnsubscribers.get(address)?.();
      this.workerUnsubscribers.delete(address);
      this.workers.delete(address);
    }
    if (record) {
      this.syncWorker(address, worker);
      this.interruptRecordWork(record);
      record.cleanup = this.cleanupDiagnostic(lease);
      record.currentActivity = `Cleanup pending; capacity held (generation ${workerGeneration})`;
      record.updatedAt = nowIso();
    }

    const operation = Promise.resolve().then(() => worker.cleanup());
    lease.operation = operation;
    this.cleanupLeases.set(worker, lease);
    this.cleanupQuarantines.set(address, lease);
    lease.settled = operation.then(
      async (report) => {
        if (report.quiescence === "verified") await this.releaseCleanupLease(lease, report);
        else {
          const toolCodes = [...new Set(report.tools.map((tool) => tool.detailCode).filter(Boolean))].slice(0, 8);
          await this.markCleanupUnknown(
            lease,
            report.abort,
            report.dispose,
            `WORKER_CLEANUP_REPORT_UNKNOWN${toolCodes.length > 0 ? `: ${toolCodes.join(",")}` : ""}`,
          );
        }
        lease.operationSettled = true;
        return report;
      },
      async (error) => {
        await this.markCleanupUnknown(lease, "failed", "failed", "WORKER_CLEANUP_REJECTED");
        lease.operationSettled = true;
        throw error;
      },
    );
    lease.settled.catch(() => undefined);
    if (!this.disposed) {
      this.persistRegistry().catch((error) => {
        this.options.mainAdapter.notifyFailure(`${address}: cleanup-pending persistence failed; in-memory safety lease remains held: ${errorMessage(error)}`);
      });
      this.publish();
    }
    return lease;
  }

  private async markCleanupUnknown(
    lease: WorkerCleanupLease,
    abort: CleanupDiagnostic["abort"],
    dispose: CleanupDiagnostic["dispose"],
    detail: string,
  ): Promise<void> {
    if (this.cleanupQuarantines.get(lease.address) !== lease) return;
    const record = this.records.get(lease.address);
    if (!record?.cleanup || record.cleanup.workerGeneration !== lease.workerGeneration) return;
    const safeDetail = safeErrorSummary(detail);
    record.cleanup = {
      ...record.cleanup,
      state: "unknown",
      updatedAt: nowIso(),
      abort,
      dispose,
      detail: safeDetail,
    };
    record.state = "failed";
    const cleanupFailure = `Cleanup quarantine: Pi session/tool settlement unknown for worker generation ${lease.workerGeneration}; exact address held; ${safeDetail}`;
    if (!record.failure) record.failure = cleanupFailure;
    else if (!record.failure.includes("Cleanup quarantine:")) record.failure = truncateText(`${record.failure}; ${cleanupFailure}`, 1_500);
    record.currentActivity = cleanupFailure;
    record.updatedAt = nowIso();
    if (this.lifecycle !== "closed") await this.persistRegistry(this.lifecycle === "closing").catch((error) => {
      this.options.mainAdapter.notifyFailure(`${lease.address}: cleanup quarantine persistence failed: ${errorMessage(error)}`);
    });
    if (!lease.alerted) {
      lease.alerted = true;
      this.options.mainAdapter.notifyFailure(`${lease.address}: ${cleanupFailure}`);
    }
    this.publish();
  }

  private async releaseCleanupLease(lease: WorkerCleanupLease, report: WorkerCleanupReport): Promise<void> {
    if (report.quiescence !== "verified" || this.lifecycle === "closed" || this.cleanupQuarantines.get(lease.address) !== lease) return;
    const record = this.records.get(lease.address);
    if (!record?.cleanup || record.cleanup.workerGeneration !== lease.workerGeneration) return;
    const previous = clone(record);
    delete record.cleanup;
    if (record.workerEpoch?.generation === lease.workerGeneration) {
      record.workerEpoch = { ...record.workerEpoch, phase: "session-settled", runSlotHeld: false };
    }
    if (lease.targetState === "stopped") {
      record.state = "stopped";
      record.currentActivity = "Stopped after Pi session/tool cleanup settled";
      if (record.failure?.startsWith("Cleanup quarantine:")) delete record.failure;
    } else if (lease.targetState === "archived") {
      record.state = "archived";
      record.currentActivity = "Archived after Pi session/tool cleanup settled";
    } else if (lease.targetState === "paused" && !["stopped", "archived"].includes(record.state)) {
      record.state = "paused";
      record.currentActivity = "Pi session/tool cleanup settled; worker paused";
    }
    if (lease.targetState !== "failed" && record.failure?.startsWith("Cleanup quarantine:")) delete record.failure;
    record.updatedAt = nowIso();
    try {
      await this.persistRegistry(this.lifecycle === "closing");
    } catch {
      this.records.set(lease.address, previous);
      await this.markCleanupUnknown(lease, "succeeded", "failed", "CLEANUP_RELEASE_PERSIST_FAILED");
      throw this.cleanupError(lease.address);
    }
    this.cleanupQuarantines.delete(lease.address);
    this.cleanupLeases.delete(lease.worker);
    this.provisionalWorkers.delete(lease.worker);
    if (lease.heldRunSlot) this.active.delete(lease.address);
    if (lease.targetState === "archived") {
      this.activationLeases.delete(lease.address);
      const pendingIndex = this.pendingStarts.indexOf(lease.address);
      if (pendingIndex >= 0) this.pendingStarts.splice(pendingIndex, 1);
    }
    this.publish();
    if (!this.disposed) this.pump();
  }

  private async waitForCleanup(lease: WorkerCleanupLease, timeoutMs: number): Promise<WorkerCleanupReport> {
    const deadline = deadlineSignal(timeoutMs);
    let outcome: { kind: "report"; report: WorkerCleanupReport } | { kind: "timeout" };
    try {
      outcome = await Promise.race([
        lease.settled.then((report) => ({ kind: "report" as const, report })),
        deadline.promise.then(() => ({ kind: "timeout" as const })),
      ]);
    } catch {
      throw this.cleanupError(lease.address);
    } finally {
      deadline.cancel();
    }
    if (outcome.kind === "timeout") {
      await this.markCleanupUnknown(
        lease,
        "timed-out",
        "timed-out",
        `LIFECYCLE_ABORT_TIMEOUT / LIFECYCLE_DISPOSE_TIMEOUT: cleanup operation remained unsettled after ${timeoutMs}ms; timeout did not cancel it.`,
      );
      throw new LifecycleTimeoutError("LIFECYCLE_DISPOSE_TIMEOUT", timeoutMs, "cleanup remains quarantined");
    }
    if (this.cleanupQuarantines.get(lease.address) === lease) throw this.cleanupError(lease.address);
    return outcome.report;
  }

  private async restoreQueuedMainMail(generation: number): Promise<void> {
    const seen = new Set<string>();
    const queued: EmailEnvelope[] = [];
    for (const alias of this.requiredRegistry().mainAliases) {
      for (const email of this.mailStore.queued(alias)) {
        if (seen.has(email.id)) continue;
        seen.add(email.id);
        queued.push(email);
      }
    }
    for (const email of sortMail(queued)) {
      this.checkpoint(generation);
      try {
        await this.options.mainAdapter.deliver({ envelope: email, formatted: formatEmail(email), triggerTurn: true });
        this.checkpoint(generation);
        await this.mailStore.markDelivered([email.id]);
      } catch (error) {
        if (this.cancelled(generation)) throw error;
        await this.failEnvelope(email, errorMessage(error));
        this.options.mainAdapter.notifyFailure(`Queued email ${email.id} could not be restored to main: ${errorMessage(error)}`);
      }
    }
  }

  private requiredRegistry(): BrokerRegistry {
    if (!this.registry) throw new Error("Email broker has not started.");
    return this.registry;
  }

  private resolveExistingRecord(record: AgentRecord): ParsedAddress {
    try {
      return parseBoundSubagentAddress(record.address, this.catalog, {
        provider: record.provider,
        modelId: record.modelId,
      });
    } catch (error) {
      throw new AddressError(`${record.address} ${errorMessage(error)}`);
    }
  }

  private firstBindingIntent(address: string): EmailEnvelope | undefined {
    return this.mailStore.list()
      .filter((email) => email.to === address && email.modelBindingIntent)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  }

  private assertActive(): void {
    if (this.disposed || this.lifecycle !== "active") throw new Error("Email broker is shutting down or not ready.");
    this.requiredRegistry();
  }

  private activeIdentityCount(): number {
    return this.activationLeases.size;
  }

  private capacitySnapshot(): AgentCapacitySnapshot {
    return {
      identitiesUsed: this.activationLeases.size,
      identitiesLimit: this.options.config.maxAgents,
      runSlotsUsed: this.active.size,
      runSlotsLimit: this.options.config.maxConcurrent,
    };
  }

  private capacityFullDiagnostic(mainCaller = true): string {
    const capacity = this.capacitySnapshot();
    const recovery = mainCaller
      ? "Reuse a relevant existing address, or use inspect_agent or /agents to restart real work, resolve exact obligations, archive one clean identity, then retry."
      : "Reuse a relevant existing address you already know, or ask main to resolve real obligations and archive one clean identity before retrying; only main can manage agents or cancel requests.";
    return `Agent limit reached: identity capacity is full (${capacity.identitiesUsed}/${capacity.identitiesLimit} activation leases). Run concurrency is separate (${capacity.runSlotsUsed}/${capacity.runSlotsLimit} slots currently used); waiting for a run slot or stopping an agent does not free an identity lease. ${recovery}`;
  }

  private boundedRequestIds(ids: readonly string[]): AgentArchiveBlockers["queued"] {
    return {
      count: ids.length,
      requestIds: ids.slice(0, ARCHIVE_BLOCKER_ID_LIMIT),
      omitted: Math.max(0, ids.length - ARCHIVE_BLOCKER_ID_LIMIT),
    };
  }

  private classifyArchiveBlockers(address: string, record?: AgentRecord, worker?: WorkerTransport): AgentArchiveBlockers {
    const queued: string[] = [];
    const incomingUnanswered: string[] = [];
    const outgoingUnanswered: string[] = [];
    const pendingReplies: string[] = [];
    for (const email of this.mailStore.list()) {
      if (email.to !== address && email.from !== address) continue;
      if (email.deliveryState === "queued") {
        queued.push(email.inReplyTo ?? email.id);
        continue;
      }
      if (email.kind !== "request" || !email.requiresResponse || email.deliveryState !== "delivered" || email.answeredAt) continue;
      if (email.replyReservedBy) {
        pendingReplies.push(email.id);
        continue;
      }
      if (email.to === address) incomingUnanswered.push(email.id);
      if (email.from === address) outgoingUnanswered.push(email.id);
    }
    return {
      active: record?.state === "running" || record?.state === "spawning" || Boolean(worker?.getSnapshot().isStreaming),
      cleanupQuarantine: Boolean(record?.cleanup || this.cleanupQuarantines.has(address)),
      queued: this.boundedRequestIds(queued),
      incomingUnanswered: this.boundedRequestIds(incomingUnanswered),
      outgoingUnanswered: this.boundedRequestIds(outgoingUnanswered),
      pendingReplies: this.boundedRequestIds(pendingReplies),
    };
  }

  private outgoingDependencies(address: string): EmailEnvelope[] {
    return this.mailStore.list().filter((email) =>
      email.kind === "request"
      && email.requiresResponse
      && email.from === address
      && !this.isMainIdentity(email.to)
      && (email.deliveryState === "queued" || email.deliveryState === "delivered")
      && !email.answeredAt);
  }

  private queuedDependencyReplies(address: string): EmailEnvelope[] {
    const blockers = new Set(this.outgoingDependencies(address).map((email) => email.id));
    return sortMail(this.mailStore.queued(address).filter((email) =>
      email.kind === "reply" && Boolean(email.inReplyTo && blockers.has(email.inReplyTo))));
  }

  private setEpochRunSlot(record: AgentRecord, held: boolean): void {
    if (record.workerEpoch?.phase === "activated") {
      record.workerEpoch = { ...record.workerEpoch, runSlotHeld: held };
    }
  }

  private async parkWorker(address: string, record: AgentRecord): Promise<void> {
    const dependencies = this.outgoingDependencies(address);
    this.clearWatchdog(address);
    this.active.delete(address);
    this.setEpochRunSlot(record, false);
    for (let index = this.pendingStarts.length - 1; index >= 0; index -= 1) {
      if (this.pendingStarts[index] === address) this.pendingStarts.splice(index, 1);
    }
    record.state = "parked";
    record.currentActivity = `Parked on ${dependencies.length} outgoing child dependenc${dependencies.length === 1 ? "y" : "ies"}`;
    record.updatedAt = nowIso();
    await this.persistRegistry();
    this.publish();
    this.pump();
  }

  private archiveEligible(record: AgentRecord | undefined, blockers: AgentArchiveBlockers): boolean {
    if (!record) return false;
    if (record.state === "archived") return true;
    return !blockers.active
      && !blockers.cleanupQuarantine
      && blockers.queued.count === 0
      && blockers.incomingUnanswered.count === 0
      && blockers.outgoingUnanswered.count === 0
      && blockers.pendingReplies.count === 0;
  }

  private archiveBlockedDiagnostic(blockers: AgentArchiveBlockers): string {
    const render = (label: string, value: AgentArchiveBlockers["queued"]): string | undefined => {
      if (value.count === 0) return undefined;
      const shown = value.requestIds.join(", ");
      const omitted = value.omitted > 0 ? `${shown ? ", " : ""}+${value.omitted} omitted` : "";
      return `${label}: ${value.count}${shown || omitted ? ` (${shown}${omitted})` : ""}`;
    };
    const categories = [
      blockers.active ? "active worker" : undefined,
      blockers.cleanupQuarantine ? "Pi session/tool cleanup unsettled" : undefined,
      render("queued mail", blockers.queued),
      render("incoming unanswered requests", blockers.incomingUnanswered),
      render("outgoing unanswered requests", blockers.outgoingUnanswered),
      render("reply deliveries pending", blockers.pendingReplies),
    ].filter((value): value is string => Boolean(value));
    const active = blockers.active
      ? " Running agents must be stopped and settled first; stopping does not free identity capacity."
      : "";
    const obligationCount = blockers.queued.count
      + blockers.incomingUnanswered.count
      + blockers.outgoingUnanswered.count
      + blockers.pendingReplies.count;
    const obligations = obligationCount > 0 ? "; queued mail or unanswered obligations block archival" : "";
    return `Agent cannot be archived: ${categories.join("; ")}${obligations}.${active} Restart or finish genuine work. If the user explicitly abandons a request and its recipient is inactive, cancel that exact request with a substantive reason; cancel_request performs final validation. Then retry archive.`;
  }

  private async withAddressOperation<T>(address: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.addressTails.get(address) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      this.assertActive();
      return operation();
    });
    const tail = run.then(() => undefined, () => undefined);
    this.addressTails.set(address, tail);
    try {
      return await run;
    } finally {
      if (this.addressTails.get(address) === tail) this.addressTails.delete(address);
    }
  }

  private async withMailAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mailAdmissionTail.catch(() => undefined).then(async () => {
      this.assertActive();
      return operation();
    });
    this.mailAdmissionTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private trackInFlight<T>(operation: Promise<T>, label: string): Promise<T> {
    this.inFlightOperations.add(operation);
    this.operationLabels.set(operation, label);
    void operation.then(
      () => { this.inFlightOperations.delete(operation); },
      () => { this.inFlightOperations.delete(operation); },
    );
    return operation;
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  private senderLimiter(sender: string): SlidingWindowRateLimiter {
    let limiter = this.senderRateLimiters.get(sender);
    if (!limiter) {
      limiter = new SlidingWindowRateLimiter(this.options.config.maxMailsPerSenderPerMinute);
      this.senderRateLimiters.set(sender, limiter);
    }
    return limiter;
  }

  private takeRateQuota(sender: string): void {
    const now = Date.now();
    const senderLimiter = this.senderLimiter(sender);
    if (!this.globalRateLimiter.canTake(now) || !senderLimiter.canTake(now)) {
      throw new Error("Email rate limit exceeded; wait before sending more mail.");
    }
    this.globalRateLimiter.take(now);
    senderLimiter.take(now);
  }

  get mainAddress(): string {
    this.requiredRegistry();
    return this.mainRouting.address;
  }

  get modelIds(): string[] {
    return this.catalog.routableModelIds(this.mainRouting.preferredProvider);
  }

  get toolResultByteLimit(): number {
    return Math.min(this.options.config.maxBatchBytes, MAIL_TOOL_BATCH_BYTES);
  }

  private isMainIdentity(address: string): boolean {
    return this.requiredRegistry().mainAliases.includes(address.toLowerCase());
  }

  private sameIdentity(left: string, right: string): boolean {
    return left === right || (this.isMainIdentity(left) && this.isMainIdentity(right));
  }

  private validateSender(sender: string): string {
    const normalized = sender.trim().toLowerCase();
    if (this.isMainIdentity(normalized) || this.records.has(normalized)) return normalized;
    throw new Error(`Unknown sender identity ${normalized}.`);
  }

  async updateMainModel(address: string, preferredProvider?: string): Promise<void> {
    this.assertActive();
    const normalized = address.toLowerCase();
    // Replace one object synchronously before persistence so a concurrent new
    // recipient observes either the old or new complete routing preference.
    this.mainRouting = { address: normalized, ...(preferredProvider ? { preferredProvider } : {}) };
    const registry = this.requiredRegistry();
    registry.mainAddress = normalized;
    registry.mainAliases = [...new Set([...registry.mainAliases, normalized])];
    await this.persistRegistry();
    this.publish();
  }

  async updateMainAddress(address: string): Promise<void> {
    await this.updateMainModel(address, this.mainRouting.preferredProvider);
  }

  private validateInput(input: SendEmailInput, isReply: boolean): void {
    if (!input.to.trim()) throw new Error("Recipient is required.");
    if (!input.subject.trim()) throw new Error("Subject is required.");
    if (/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.subject)) {
      throw new Error("Subject cannot contain line breaks or control characters.");
    }
    if (!input.message.trim()) throw new Error("Message is required.");
    if (input.priority !== "high" && input.priority !== "low") throw new Error("Priority must be high or low.");
    if (input.effort !== undefined && !isThinkingLevel(input.effort)) {
      throw new Error("Effort must be one of off, minimal, low, medium, high, xhigh, or max.");
    }
    // Reply subjects carry the `Re: [mail-id] ` prefix on top of the original
    // subject; without the allowance, maximally sized requests would be
    // impossible to answer.
    const subjectLimit = this.options.config.maxSubjectBytes + (isReply ? REPLY_PREFIX_ALLOWANCE_BYTES : 0);
    if (byteLength(input.subject) > subjectLimit) {
      throw new Error(`Subject exceeds ${subjectLimit} bytes.`);
    }
    if (byteLength(input.message) > this.options.config.maxMessageBytes) {
      throw new Error(`Message exceeds ${this.options.config.maxMessageBytes} bytes.`);
    }
  }

  private validateReplyOwnership(
    sender: string,
    to: string,
    reply: NonNullable<ReturnType<typeof parseReplySubject>>,
  ): EmailEnvelope {
    const original = this.mailStore.get(reply.emailId);
    if (!original) throw new Error(`Reply references unknown email ${reply.emailId}.`);
    if (!original.requiresResponse) throw new Error(`${reply.emailId} is a reply and does not require an answer.`);
    if (original.answeredAt) throw new Error(`${reply.emailId} was already answered by ${original.answeredBy}.`);
    if (original.replyReservedBy) throw new Error(`${reply.emailId} already has reply ${original.replyReservedBy} pending delivery.`);
    if (original.deliveryState !== "delivered") throw new Error(`${reply.emailId} has not been delivered yet.`);
    if (!this.sameIdentity(original.to, sender) || !this.sameIdentity(original.from, to)) {
      throw new Error(`Reply ${reply.emailId} does not belong to this sender/recipient pair.`);
    }
    if (reply.originalSubject !== original.subject) {
      throw new Error(`Reply subject does not exactly match ${reply.emailId}. Use: Re: [${reply.emailId}] ${original.subject}`);
    }
    return original;
  }

  private validateDeliverySize(envelope: EmailEnvelope, model?: { contextWindow: number; maxTokens: number }): void {
    const formatted = formatEmail(envelope);
    const modelLimit = model ? conservativeModelEnvelopeBudget(model) : Number.MAX_SAFE_INTEGER;
    const byteLimit = Math.min(this.toolResultByteLimit, modelLimit);
    if (byteLength(formatted) > byteLimit) {
      throw new Error(`Formatted email exceeds the ${byteLimit}-byte context-safe envelope limit.`);
    }
    const lines = formatted.split("\n").length;
    if (lines > MAIL_TOOL_BATCH_LINES) {
      throw new Error(`Formatted email exceeds the ${MAIL_TOOL_BATCH_LINES}-line context-safe envelope limit.`);
    }
  }

  private validateQueueCapacity(recipient: string, input: SendEmailInput): void {
    const queued = this.mailStore.queuedMetrics(recipient);
    const messageBytes = byteLength(input.subject) + byteLength(input.message);
    const nextBytes = queued.bytes + messageBytes;
    if (queued.count >= this.options.config.maxQueuedMessages || nextBytes > this.options.config.maxQueuedBytes) {
      throw new Error(`Mailbox queue for ${recipient} is full; wait for existing work or use another existing agent.`);
    }
  }

  private async failEnvelope(envelope: EmailEnvelope, error: string): Promise<void> {
    await this.mailStore.markFailed(envelope.id, error);
    if (!envelope.inReplyTo) return;
    const original = this.mailStore.get(envelope.inReplyTo);
    if (!original || original.answeredAt || original.replyReservedBy || original.deliveryState !== "delivered") return;
    if (this.isMainIdentity(original.to)) {
      this.options.mainAdapter.notifyFailure(`Reply ${envelope.id} failed delivery; request ${original.id} is open again.`);
      return;
    }
    if (this.workers.has(original.to)) swallow(this.trackInFlight(
      this.resumeEnforcement(original.to),
      `enforcement:${original.to}`,
    ));
  }

  private cancellationWakeExists(requestId: string): boolean {
    return this.mailStore.list().some((email) =>
      email.kind === "reply"
      && email.inReplyTo === requestId
      && email.subject === `Cancelled child request ${requestId}`);
  }

  private async ensureCancellationWakeJournal(request: EmailEnvelope): Promise<EmailEnvelope | undefined> {
    if (this.isMainIdentity(request.from) || this.cancellationWakeExists(request.id)) return undefined;
    const reason = truncateText((request.cancellationReason ?? "Administrative cancellation").replace(/\s+/g, " "), 512);
    const wake: EmailEnvelope = {
      id: createMailId(),
      from: this.mainRouting.address,
      to: request.from,
      subject: `Cancelled child request ${request.id}`,
      message: `Terminal cancellation status for child request ${request.id}: ${reason}. This closes only that child dependency. The parent's upstream request remains open and must still receive a substantive reply.`,
      priority: "low",
      kind: "reply",
      inReplyTo: request.id,
      requiresResponse: false,
      createdAt: nowIso(),
      deliveryState: "queued",
    };
    this.validateDeliverySize(wake);
    await this.mailStore.accept(wake);
    return wake;
  }

  private terminalChildBlockerMessage(record: AgentRecord, requestId: string): string {
    const effects = currentBatchHasEffectfulWork(record.work)
      ? "Current work evidence indicates mutation, shell, or custom effects may exist."
      : "Current work evidence does not indicate mutation, shell, or custom effects; this is not proof of pre-tool failure.";
    return `Broker-generated dependency blocker (not a worker-authored completion) for child request ${requestId}: ${record.address} failed (${record.provider}/${record.modelId}). ${effects} This is terminal failure status, not a successful result. Ask main to inspect Work and Conversation, perform effect review, and explicitly restart the same identity if recovery is safe; do not resend, redelegate, or switch providers automatically.`;
  }

  private async ensureTerminalChildBlockers(record: AgentRecord): Promise<void> {
    const requests = this.mailStore.list().filter((email) =>
      email.kind === "request"
      && email.requiresResponse
      && email.to === record.address
      && !this.isMainIdentity(email.from)
      && email.deliveryState === "delivered"
      && !email.answeredAt
      && !email.replyReservedBy);
    for (const snapshot of requests) {
      let blocker: EmailEnvelope | undefined;
      await this.withMailAdmission(async () => {
        const request = this.mailStore.get(snapshot.id);
        if (!request || request.deliveryState !== "delivered" || request.answeredAt || request.replyReservedBy) return;
        blocker = {
          id: createMailId(),
          from: record.address,
          to: request.from,
          subject: makeReplySubject(request.id, request.subject),
          message: this.terminalChildBlockerMessage(record, request.id),
          priority: "low",
          kind: "reply",
          inReplyTo: request.id,
          requiresResponse: false,
          createdAt: nowIso(),
          deliveryState: "queued",
        };
        this.validateDeliverySize(blocker);
        await this.mailStore.reserveReply(blocker, request.id);
      });
      if (!blocker) continue;
      try {
        await this.ensureWorker(blocker.to, undefined, blocker);
      } catch (error) {
        // The accepted blocker and its reservation remain queued for explicit
        // same-identity recovery; never generate a replacement mail ID.
        void error;
        this.options.mainAdapter.notifyFailure(
          `Dependency blocker ${blocker.id} for ${snapshot.id} remains queued; the parent requires explicit same-identity recovery before delivery can continue.`,
        );
      }
    }
    this.scheduleMailMaintenance();
    this.emitChange();
  }

  send(senderInput: string, input: SendEmailInput, signal?: AbortSignal): Promise<SendEmailResult> {
    const operation = this.sendInternal(senderInput, input, signal);
    const tracked = operation.then(
      (result) => {
        this.inFlightOperations.delete(tracked);
        return result;
      },
      (error) => {
        this.inFlightOperations.delete(tracked);
        throw error;
      },
    );
    this.inFlightOperations.add(tracked);
    this.operationLabels.set(tracked, `send:${senderInput.trim().toLowerCase()}->${input.to.trim().toLowerCase()}`);
    return tracked;
  }

  private async sendInternal(senderInput: string, input: SendEmailInput, signal?: AbortSignal): Promise<SendEmailResult> {
    this.assertActive();
    if (signal?.aborted) throw new Error("Email send aborted before acceptance.");
    const reply = parseReplySubject(input.subject);
    this.validateInput(input, Boolean(reply));
    if (input.lifecycle?.brokerShutdownTimeoutMs !== undefined) {
      throw new Error("lifecycle.brokerShutdownTimeoutMs is administrator-controlled global configuration and cannot be overridden by a delegation.");
    }
    const sender = this.validateSender(senderInput);
    const requestedTo = input.to.trim().toLowerCase();
    if (this.sameIdentity(sender, requestedTo)) throw new Error("Sending email to yourself is not supported.");

    const toMain = this.isMainIdentity(requestedTo);
    let parsed: ParsedAddress | undefined;
    let failedKnown = false;
    let to = requestedTo;
    let initialEffort: ThinkingLevel | undefined;
    let initialLifecycle: LifecyclePolicy | undefined;
    if (!toMain) {
      const shape = parseSubagentAddressShape(requestedTo);
      const existingRecord = this.records.get(shape.address);
      to = shape.address;
      const senderRecord = this.records.get(sender);
      if (senderRecord && !senderRecord.canSpawn && !reply) {
        throw new Error(`Agent ${sender} is not permitted to delegate to subagents; response-required requests to known and unknown subagents are disabled.`);
      }
      failedKnown = existingRecord?.state === "failed";
      if (!failedKnown) {
        parsed = existingRecord
          ? this.resolveExistingRecord(existingRecord)
          : parseNewSubagentAddress(shape.address, this.catalog, this.mainRouting.preferredProvider);
      }
      if (this.sameIdentity(sender, to)) throw new Error("Sending email to yourself is not supported.");
      if (input.effort !== undefined && existingRecord) {
        throw new Error(`Effort overrides are accepted only on the first delegation to an unknown address. ${to} already exists (${existingRecord.state}); omit effort and use its persisted value. Archived restoration also preserves its original effort.`);
      }
      if (input.lifecycle !== undefined && existingRecord) {
        throw new Error(`Lifecycle overrides are accepted only on the first delegation to an unknown address. ${to} already exists (${existingRecord.state}); omit lifecycle and use its persisted policy. Archived restoration also preserves its original policy.`);
      }
      initialEffort = existingRecord?.effort
        ?? input.effort
        ?? resolveAgentProfile(this.options.config, to, parsed!.name).effort;
      initialLifecycle = existingRecord?.lifecycle ?? resolveLifecycle(this.options.config, to, parsed!.name, input.lifecycle);
      if (!failedKnown && !this.activationLeases.has(to) && this.activeIdentityCount() >= this.options.config.maxAgents) {
        throw new Error(this.capacityFullDiagnostic(this.isMainIdentity(sender)));
      }
    } else {
      if (input.effort !== undefined) {
        throw new Error("Effort overrides apply only when creating an unknown subagent, not when mailing the main identity.");
      }
      if (input.lifecycle !== undefined) {
        throw new Error("Lifecycle overrides apply only when creating an unknown subagent, not when mailing the main identity.");
      }
    }

    if (!reply && looksLikeReply(input.subject)) {
      throw new Error("Malformed reply subject. Copy the exact `Re: [mail-id] original subject` from fetch_emails().");
    }

    let answeredEmailId = reply ? this.validateReplyOwnership(sender, to, reply).id : undefined;

    let acquiredLease = false;
    let workerPreparation: unknown;
    let envelope!: EmailEnvelope;
    try {
      await this.withAddressOperation(to, async () => {
        const currentWorker = this.workers.get(to);
        const currentRecord = this.records.get(to);
        const acceptedCreation = toMain ? undefined : this.firstBindingIntent(to);
        if (!toMain) {
          failedKnown = currentRecord?.state === "failed";
          if (!failedKnown) {
            if (currentRecord) parsed = this.resolveExistingRecord(currentRecord);
            else if (acceptedCreation?.modelBindingIntent) {
              parsed = parseBoundSubagentAddress(to, this.catalog, acceptedCreation.modelBindingIntent);
            }
            if (!parsed) throw new Error(`Recipient ${to} has no model binding.`);
          }
          if (input.effort !== undefined && (currentRecord || acceptedCreation)) {
            throw new Error(`Effort overrides are accepted only on the first delegation to an unknown address. ${to} already has durable identity intent; omit effort and use its persisted value.`);
          }
          if (input.lifecycle !== undefined && (currentRecord || acceptedCreation)) {
            throw new Error(`Lifecycle overrides are accepted only on the first delegation to an unknown address. ${to} already has durable identity intent; omit lifecycle and use its persisted policy.`);
          }
          initialEffort = currentRecord?.effort
            ?? acceptedCreation?.effortIntent
            ?? input.effort
            ?? resolveAgentProfile(this.options.config, to, parsed!.name).effort;
          initialLifecycle = currentRecord?.lifecycle
            ?? acceptedCreation?.lifecycleIntent
            ?? resolveLifecycle(this.options.config, to, parsed!.name, input.lifecycle);
          if (!failedKnown && !this.activationLeases.has(to)) {
            if (this.activeIdentityCount() >= this.options.config.maxAgents) {
              throw new Error(this.capacityFullDiagnostic(this.isMainIdentity(sender)));
            }
            this.activationLeases.add(to);
            acquiredLease = true;
          }
        }

        const firstIdentityMail = Boolean(parsed && !currentRecord && !acceptedCreation && !reply);
        envelope = {
          id: createMailId(),
          from: sender,
          to,
          subject: input.subject.trim(),
          message: input.message,
          priority: input.priority,
          kind: reply ? "reply" : "request",
          ...(reply ? { inReplyTo: reply.emailId } : {}),
          requiresResponse: !reply,
          createdAt: nowIso(),
          deliveryState: "queued",
          ...(firstIdentityMail ? {
            effortIntent: initialEffort!,
            lifecycleIntent: { ...initialLifecycle! },
            modelBindingIntent: { provider: parsed!.model.provider, modelId: parsed!.model.id },
          } : {}),
        };
        this.validateDeliverySize(envelope, parsed?.model);
        if (firstIdentityMail) workerPreparation = await this.options.workerPreflight?.(parsed!.model);
        await this.withMailAdmission(async () => {
          const currentSender = this.records.get(sender);
          if (!toMain && !reply && currentSender && !currentSender.canSpawn) {
            throw new Error(`Agent ${sender} is not permitted to delegate to subagents; response-required requests to known and unknown subagents are disabled.`);
          }
          if (reply) {
            const original = this.validateReplyOwnership(sender, to, reply);
            const dependencyDelivery = this.dependencyDeliveryTransitions.get(sender);
            if (dependencyDelivery) await dependencyDelivery;
            if (currentSender && this.outgoingDependencies(sender).length > 0) {
              throw new Error(`Agent ${sender} cannot answer ${original.id} while an outgoing child dependency is still open.`);
            }
            answeredEmailId = original.id;
          }
          const steersImmediately = !toMain
            && input.priority === "high"
            && Boolean(currentWorker?.getSnapshot().isStreaming);
          if (!toMain && !steersImmediately) this.validateQueueCapacity(to, input);
          // This is the final synchronous pre-append linearization check. Once
          // accept/reserveReply is invoked, journal ownership continues even if
          // the caller aborts while the append is pending.
          if (signal?.aborted) throw new Error("Email send aborted before acceptance.");
          this.takeRateQuota(sender);
          if (answeredEmailId) await this.mailStore.reserveReply(envelope, answeredEmailId);
          else await this.mailStore.accept(envelope);
        });
        if (firstIdentityMail && workerPreparation !== undefined) {
          this.preparedWorkerRuntimes.set(to, workerPreparation);
        }
      });
    } catch (error) {
      if (acquiredLease) this.activationLeases.delete(to);
      throw error;
    }

    let spawned = false;
    let disposition: SendEmailResult["recipientDisposition"] = toMain ? "main" : "reused";
    let recipientRecord: AgentRecord | undefined;
    try {
      if (toMain) {
        const collectionClaim = this.claimCollection(envelope);
        try {
          if (!collectionClaim) {
            await this.options.mainAdapter.deliver({ envelope, formatted: formatEmail(envelope), triggerTurn: true });
          }
          await this.mailStore.markDelivered([envelope.id]);
        } finally {
          if (collectionClaim) this.releaseCollectionClaim(collectionClaim);
        }
      } else {
        const ensured = await this.ensureWorker(to, parsed, envelope, workerPreparation);
        spawned = ensured.spawned;
        disposition = ensured.disposition;
        recipientRecord = this.records.get(to);
      }
    } catch (error) {
      // Lifecycle and cleanup-quarantine failures retain accepted queued/open
      // mail for later verified recovery rather than fabricating terminal loss.
      if (!(error instanceof LifecycleTimeoutError)
        && !(error instanceof CleanupQuarantineError)
        && !(error instanceof ProviderReadinessError)) {
        await this.failEnvelope(envelope, errorMessage(error));
      }
      this.scheduleMailMaintenance();
      this.publish();
      throw new Error(`Email ${envelope.id} was persisted but delivery failed: ${errorMessage(error)}`);
    }

    this.scheduleMailMaintenance();
    await this.persistRegistry();
    this.publish();
    const stored = this.mailStore.get(envelope.id) ?? envelope;
    return {
      envelope: stored,
      spawned,
      recipientDisposition: disposition,
      correlationId: envelope.id,
      ...(envelope.requiresResponse ? { expectedReplySubject: makeReplySubject(envelope.id, envelope.subject) } : {}),
      ...(recipientRecord ? {
        recipientModel: recipientRecord.modelId,
        recipientProvider: recipientRecord.provider,
        recipientEffort: recipientRecord.effort,
        recipientRole: recipientRecord.name,
        recipientTools: [...(this.liveActiveTools(recipientRecord.address) ?? recipientRecord.tools)],
        recipientState: recipientRecord.state,
        recipientLifecycle: { ...recipientRecord.lifecycle },
        ...(recipientRecord.cleanup ? { recipientCleanup: clone(recipientRecord.cleanup) } : {}),
      } : {}),
      ...(answeredEmailId ? { answeredEmailId } : {}),
    };
  }

  fetchUnanswered(addressInput: string): EmailEnvelope[] {
    this.assertActive();
    const address = this.validateSender(addressInput);
    if (this.isMainIdentity(address)) {
      const ids = new Set<string>();
      const result: EmailEnvelope[] = [];
      for (const alias of this.requiredRegistry().mainAliases) {
        for (const email of this.mailStore.unanswered(alias)) {
          if (!ids.has(email.id)) {
            ids.add(email.id);
            result.push(email);
          }
        }
      }
      return sortMail(result);
    }
    return this.mailStore.unanswered(address);
  }

  private async ensureWorker(address: string, parsed: ParsedAddress | undefined, envelope: EmailEnvelope, preparation?: unknown): Promise<{
    worker?: WorkerTransport;
    spawned: boolean;
    disposition: SendEmailResult["recipientDisposition"];
  }> {
    return this.withAddressOperation(address, async () => {
      let record = this.records.get(address);
      if (record?.state === "failed") {
        return { spawned: false, disposition: "failed" as const };
      }
      parsed ??= record ? this.resolveExistingRecord(record) : undefined;
      if (!parsed) throw new Error(`Recipient ${address} has no model binding.`);
      if (this.cleanupQuarantines.has(parsed.address) || record?.cleanup) {
        const spawned = !record;
        if (!record) {
          record = this.makeRecord(parsed, envelope.lifecycleIntent, envelope.effortIntent);
          record.state = "queued";
          record.currentActivity = "Accepted mail deferred by exact-address cleanup settlement";
          this.records.set(record.address, record);
          this.routableRecords.add(record.address);
        }
        this.enqueueStart(parsed.address);
        await this.persistRegistry();
        this.publish();
        return {
          spawned,
          disposition: spawned ? "spawned" as const : "reused" as const,
        };
      }
      const existingWorker = this.workers.get(parsed.address);
      if (existingWorker) {
        await this.routeToWorker(envelope, existingWorker);
        return { worker: existingWorker, spawned: false, disposition: "reused" as const };
      }
      if (record?.state === "stopped") return { spawned: false, disposition: "stopped" as const };
      const restoringArchive = record?.state === "archived";
      if (!this.activationLeases.has(parsed.address)) {
        if (this.activeIdentityCount() >= this.options.config.maxAgents) {
          throw new Error(this.capacityFullDiagnostic());
        }
        this.activationLeases.add(parsed.address);
      }
      const worker = await this.createWorker(
        parsed,
        record,
        this.lifecycleGeneration,
        envelope.lifecycleIntent,
        envelope.effortIntent,
        preparation,
      );
      await this.routeToWorker(envelope, worker);
      return {
        worker,
        spawned: !record,
        disposition: restoringArchive ? "restored" as const : (!record ? "spawned" as const : "reused" as const),
      };
    });
  }

  private makeRecord(
    parsed: ParsedAddress,
    lifecycle = resolveLifecycle(this.options.config, parsed.address, parsed.name),
    effortIntent?: ThinkingLevel,
  ): AgentRecord {
    const profile = resolveAgentProfile(this.options.config, parsed.address, parsed.name);
    const now = nowIso();
    return {
      address: parsed.address,
      name: parsed.name,
      taskSlug: parsed.taskSlug,
      provider: parsed.model.provider,
      modelId: parsed.model.id,
      effort: effortIntent ?? profile.effort,
      tools: profile.tools,
      canSpawn: false,
      ...(profile.instructions !== undefined ? { instructions: profile.instructions } : {}),
      state: "spawning",
      createdAt: now,
      updatedAt: now,
      enforcementAttempts: 0,
      lifecycle: { ...lifecycle },
      usage: emptyUsage(),
      activity: [],
      work: emptyWorkState(),
    };
  }

  private makeUnavailableRecord(
    shape: ReturnType<typeof parseSubagentAddressShape>,
    createdAt: string,
    reason: string,
    binding?: ModelBinding,
    lifecycleIntent?: LifecyclePolicy,
    effortIntent?: ThinkingLevel,
  ): AgentRecord {
    const failure = truncateText(`Model unavailable during restore: ${reason}`, 1_500);
    return {
      address: shape.address,
      name: shape.name,
      taskSlug: shape.taskSlug,
      provider: binding?.provider ?? "unavailable",
      modelId: binding?.modelId ?? shape.modelId,
      effort: effortIntent ?? this.options.config.defaultEffort,
      tools: [],
      canSpawn: false,
      state: "failed",
      createdAt,
      updatedAt: nowIso(),
      currentActivity: failure,
      failure,
      enforcementAttempts: 0,
      lifecycle: lifecycleIntent ? { ...lifecycleIntent } : resolveLifecycle(this.options.config, shape.address, shape.name),
      usage: emptyUsage(),
      activity: [{ at: nowIso(), kind: "error", summary: failure }],
      work: emptyWorkState(),
    };
  }

  private async createWorker(
    parsed: ParsedAddress,
    restored?: AgentRecord,
    generation = this.lifecycleGeneration,
    lifecycleIntent?: LifecyclePolicy,
    effortIntent?: ThinkingLevel,
    preparation?: unknown,
  ): Promise<WorkerTransport> {
    const record = restored ?? this.makeRecord(parsed, lifecycleIntent, effortIntent);
    record.state = "spawning";
    delete record.failure;
    record.updatedAt = nowIso();
    this.records.set(record.address, record);
    this.routableRecords.add(record.address);
    const assignedWorkerGeneration = ++this.nextWorkerGeneration;
    const configuredTools = this.capabilityTools(record.tools);
    record.workerEpoch = {
      generation: assignedWorkerGeneration,
      phase: "spawning",
      tools: configuredTools,
      mutationCapable: this.isToolSetMutationCapable(configuredTools),
      runSlotHeld: false,
    };
    // Configured capability intent and its exact generation are durable before
    // the factory or Pi session can perform startup work.
    await this.persistRegistry(true);
    const spawnStartedAt = Date.now();
    let worker: WorkerTransport;
    const exactPreparation = preparation ?? this.preparedWorkerRuntimes.get(record.address);
    this.preparedWorkerRuntimes.delete(record.address);
    const factoryPromise = Promise.resolve(this.options.workerFactory(parsed.model, exactPreparation));
    try {
      worker = await bounded(factoryPromise, record.lifecycle.spawnTimeoutMs, "LIFECYCLE_SPAWN_TIMEOUT");
    } catch (error) {
      if (error instanceof LifecycleTimeoutError) {
        const pending: PendingFactoryLease = {
          address: record.address,
          workerGeneration: assignedWorkerGeneration,
          factory: factoryPromise,
        };
        this.pendingFactories.set(record.address, pending);
        const at = nowIso();
        record.cleanup = {
          state: "pending",
          reasonCode: "LIFECYCLE_SPAWN_FACTORY_PENDING",
          workerGeneration: assignedWorkerGeneration,
          startedAt: at,
          updatedAt: at,
          abort: "pending",
          dispose: "pending",
          quiescence: "unknown",
          mutationCapableAtStart: record.workerEpoch?.mutationCapable ?? true,
          heldRunSlot: false,
          activeTools: [],
          detail: "Worker factory deadline elapsed; exact generation settlement and cleanup are still pending.",
        };
        record.state = "failed";
        record.failure = errorMessage(error);
        record.currentActivity = `Factory generation ${assignedWorkerGeneration} pending; cleanup quarantine holds capacity`;
        record.updatedAt = at;
        await this.persistRegistry();
        this.publish();

        const lateSettlement = factoryPromise.then(async (late) => {
          if (this.pendingFactories.get(record.address) !== pending) return;
          this.workerGeneration(late, record.address, assignedWorkerGeneration);
          const lease = this.beginWorkerCleanup(record.address, late, "LIFECYCLE_SPAWN_TIMEOUT", "failed");
          try {
            await this.waitForCleanup(lease, lifecycleDuration(record.lifecycle.abortTimeoutMs, record.lifecycle.disposeTimeoutMs));
          } finally {
            if (this.pendingFactories.get(record.address) === pending) this.pendingFactories.delete(record.address);
          }
        }, async () => {
          if (this.pendingFactories.get(record.address) !== pending) return;
          const current = this.records.get(record.address);
          if (current?.cleanup?.workerGeneration === assignedWorkerGeneration) {
            delete current.cleanup;
            if (current.workerEpoch?.generation === assignedWorkerGeneration) {
              current.workerEpoch = { ...current.workerEpoch, phase: "session-settled", runSlotHeld: false };
            }
            current.updatedAt = nowIso();
          }
          this.pendingFactories.delete(record.address);
          if (this.lifecycle !== "closed") await this.persistRegistry(this.lifecycle === "closing");
          this.publish();
        });
        this.trackInFlight(lateSettlement, `pending-factory:${record.address}:generation-${assignedWorkerGeneration}`);
        swallow(lateSettlement);
      } else if (!this.cancelled(generation)) {
        record.state = "failed";
        record.failure = errorMessage(error);
        record.updatedAt = nowIso();
        await this.persistRegistry();
        this.publish();
      }
      throw error;
    }
    this.workerGeneration(worker, record.address, assignedWorkerGeneration);
    if (this.cancelled(generation)) {
      const lease = this.beginWorkerCleanup(record.address, worker, "BROKER_START_CANCELLED", "paused");
      await this.waitForCleanup(lease, lifecycleDuration(record.lifecycle.abortTimeoutMs, record.lifecycle.disposeTimeoutMs)).catch(() => undefined);
      throw new Error("Worker creation was cancelled by broker shutdown.");
    }
    this.provisionalWorkers.add(worker);
    const unsubscribe = worker.subscribe((event) => this.onWorkerEvent(record.address, worker, event));

    try {
      const remainingSpawnMs = Math.max(1, record.lifecycle.spawnTimeoutMs - (Date.now() - spawnStartedAt));
      await bounded(worker.start({
        record,
        model: parsed.model,
        cwd: this.options.cwd,
        agentDir: this.options.agentDir,
        sessionDir: join(this.options.namespaceDir, "sessions"),
        projectTrusted: this.options.projectTrusted,
        systemPrompt: subagentPrompt(record, this.mainAddress, this.modelIds, this.options.config.modelPolicy),
        sendEmail: (input, signal) => this.send(record.address, input, signal),
        fetchEmails: () => this.fetchUnansweredBatch(record.address),
      }), remainingSpawnMs, "LIFECYCLE_SPAWN_TIMEOUT");
      if (this.cancelled(generation)) throw new Error("Worker creation was cancelled by broker shutdown.");
      const previous = this.workers.get(record.address);
      if (previous && previous !== worker) throw new Error(`Agent ${record.address} already has a live worker.`);
      const activeTools = this.capabilityTools(worker.getSnapshot().activeTools);
      record.workerEpoch = {
        generation: assignedWorkerGeneration,
        phase: "activated",
        tools: activeTools,
        mutationCapable: this.isToolSetMutationCapable(activeTools),
        runSlotHeld: false,
      };
      this.workers.set(record.address, worker);
      this.clearToolLifecycle(record.address);
      this.toolLifecycles.set(record.address, { worker, calls: new Map() });
      this.clearRunLifecycle(record.address);
      this.runLifecycles.set(record.address, { worker });
      this.workerUnsubscribers.set(record.address, unsubscribe);
      this.provisionalWorkers.delete(worker);
      this.syncWorker(record.address, worker);
      record.state = "idle";
      delete record.failure;
      await this.persistRegistry();
      this.publish();
      return worker;
    } catch (error) {
      unsubscribe();
      this.provisionalWorkers.delete(worker);
      if (this.workers.get(record.address) === worker) this.workers.delete(record.address);
      this.clearToolLifecycle(record.address, worker);
      this.clearRunLifecycle(record.address, worker);
      if (this.workerUnsubscribers.get(record.address) === unsubscribe) this.workerUnsubscribers.delete(record.address);
      if (!this.cancelled(generation)) {
        record.state = "failed";
        record.failure = errorMessage(error);
        record.updatedAt = nowIso();
      }
      const cleanupLease = this.beginWorkerCleanup(record.address, worker, "WORKER_START_FAILED", "failed");
      await this.waitForCleanup(
        cleanupLease,
        lifecycleDuration(record.lifecycle.abortTimeoutMs, record.lifecycle.disposeTimeoutMs),
      ).catch(() => undefined);
      if (!this.cancelled(generation)) {
        await this.persistRegistry();
        this.publish();
      }
      throw error;
    }
  }

  private clearRunLifecycle(address: string, worker?: WorkerTransport): void {
    const current = this.runLifecycles.get(address);
    if (worker && current?.worker !== worker) return;
    current?.retry?.timer?.cancel();
    this.runLifecycles.delete(address);
  }

  private clearWatchdog(address: string, preserveRunLifecycle = false): void {
    const current = this.watchdogs.get(address);
    if (current?.run) clearTimeout(current.run);
    if (current?.idle) clearTimeout(current.idle);
    this.watchdogs.delete(address);
    if (!preserveRunLifecycle) this.clearRunLifecycle(address, current?.worker);
  }

  private clearToolLifecycle(address: string, worker?: WorkerTransport): void {
    const current = this.toolLifecycles.get(address);
    if (!worker || current?.worker === worker) this.toolLifecycles.delete(address);
  }

  private retrySchedulingSlackMs(record: AgentRecord): number {
    return Math.min(1_000, Math.max(0, Math.floor(record.lifecycle.idleTimeoutMs / 10)));
  }

  private modelProgressCoalesceMs(record: AgentRecord): number {
    // A progress pulse can never be coalesced for the full accepted idle
    // deadline, including the configured 1ms extreme.
    return Math.max(0, Math.min(1_000, record.lifecycle.idleTimeoutMs - 1, Math.floor(record.lifecycle.idleTimeoutMs / 4)));
  }

  private scheduleRetryHoldExpiry(address: string, state: RunLivenessState, watchdog: WatchdogEntry): void {
    const hold = state.retry;
    if (!hold) return;
    hold.timer?.cancel();
    const remaining = hold.deadline - Date.now();
    if (remaining <= 0) {
      delete state.retry;
      this.refreshIdleWatchdog(address, watchdog.generation, watchdog.worker);
      return;
    }
    hold.timer = deadlineSignal(remaining, { unref: true });
    void hold.timer.promise.then(() => {
      const currentState = this.runLifecycles.get(address);
      const currentWatchdog = this.watchdogs.get(address);
      if (currentState !== state || currentState.retry !== hold
        || currentWatchdog !== watchdog || Date.now() < hold.deadline) return;
      delete currentState.retry;
      this.refreshIdleWatchdog(address, watchdog.generation, watchdog.worker);
    });
  }

  private startWatchdog(address: string): void {
    const record = this.records.get(address);
    const worker = this.workers.get(address);
    if (!record || !worker) return;
    this.clearWatchdog(address, true);
    const generation = ++this.watchdogGeneration;
    const startedAt = Date.now();
    const entry: WatchdogEntry = {
      generation,
      worker,
      startedAt,
      lastIdleAt: startedAt,
      idleGeneration: 0,
    };
    let tools = this.toolLifecycles.get(address);
    if (!tools || tools.worker !== worker) {
      tools = { worker, calls: new Map() };
      this.toolLifecycles.set(address, tools);
    } else if (tools.watchdogGeneration !== undefined && tools.watchdogGeneration !== generation) {
      tools.calls.clear();
    }
    tools.watchdogGeneration = generation;
    let liveness = this.runLifecycles.get(address);
    if (!liveness || liveness.worker !== worker
      || (liveness.watchdogGeneration !== undefined && liveness.watchdogGeneration !== generation)) {
      this.clearRunLifecycle(address);
      liveness = { worker };
      this.runLifecycles.set(address, liveness);
    }
    liveness.watchdogGeneration = generation;
    entry.run = setTimeout(
      () => swallow(this.trackInFlight(
        this.expireWorker(address, generation, "LIFECYCLE_RUN_TIMEOUT", worker),
        `watchdog-expire:${address}:run`,
      )),
      runtimeSafeDelay(record.lifecycle.runTimeoutMs),
    );
    this.watchdogs.set(address, entry);
    if (liveness.retry) this.scheduleRetryHoldExpiry(address, liveness, entry);
    this.refreshIdleWatchdog(address, generation, worker);
  }

  private refreshIdleWatchdog(address: string, generation: number, worker: WorkerTransport): void {
    const entry = this.watchdogs.get(address);
    const record = this.records.get(address);
    if (!entry || entry.generation !== generation || entry.worker !== worker || !record) return;
    let tools = this.toolLifecycles.get(address);
    if (!tools || tools.worker !== worker) {
      tools = { worker, watchdogGeneration: generation, calls: new Map() };
      this.toolLifecycles.set(address, tools);
    }
    if (tools.watchdogGeneration === undefined) tools.watchdogGeneration = generation;
    if (tools.watchdogGeneration !== generation) return;
    const liveness = this.runLifecycles.get(address);
    if (liveness && (liveness.worker !== worker || liveness.watchdogGeneration !== generation)) return;
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = undefined;
    entry.idleGeneration += 1;
    if (tools.calls.size > 0 || Boolean(liveness?.retry)) return;
    entry.lastIdleAt = Date.now();
    const idleGeneration = entry.idleGeneration;
    entry.idle = setTimeout(
      () => swallow(this.trackInFlight(
        this.expireWorker(
          address,
          generation,
          "LIFECYCLE_IDLE_TIMEOUT",
          worker,
          idleGeneration,
        ),
        `watchdog-expire:${address}:idle`,
      )),
      runtimeSafeDelay(record.lifecycle.idleTimeoutMs),
    );
  }

  private touchWatchdog(address: string): void {
    const entry = this.watchdogs.get(address);
    if (!entry) return;
    this.refreshIdleWatchdog(address, entry.generation, entry.worker);
  }

  private onRunLiveness(address: string, worker: WorkerTransport, event: WorkerRunLivenessEvent): void {
    const watchdog = this.watchdogs.get(address);
    let state = this.runLifecycles.get(address);
    if (!state || state.worker !== worker) {
      this.clearRunLifecycle(address);
      state = { worker, ...(watchdog ? { watchdogGeneration: watchdog.generation } : {}) };
      this.runLifecycles.set(address, state);
    }
    if (watchdog) {
      if (state.watchdogGeneration === undefined) state.watchdogGeneration = watchdog.generation;
      if (state.watchdogGeneration !== watchdog.generation || watchdog.worker !== worker) return;
    } else if (state.watchdogGeneration !== undefined) return;

    const clearRetry = (): void => {
      state!.retry?.timer?.cancel();
      delete state!.retry;
    };
    const pulse = (coalesced: boolean): void => {
      const now = Date.now();
      const record = this.records.get(address);
      if (coalesced && record && state!.lastPulseAt !== undefined
        && now - state!.lastPulseAt < this.modelProgressCoalesceMs(record)) return;
      state!.lastPulseAt = now;
      if (watchdog) this.refreshIdleWatchdog(address, watchdog.generation, worker);
    };

    if (event.phase === "retry_start") {
      const record = this.records.get(address);
      if (!record || !Number.isFinite(event.delayMs) || event.delayMs! < 0) return;
      clearRetry();
      const slack = this.retrySchedulingSlackMs(record);
      const retryDelay = Math.min(MAX_TIMER_DELAY_MS - slack, event.delayMs!);
      state.retry = {
        deadline: Date.now() + retryDelay + slack,
      };
      if (watchdog) {
        this.scheduleRetryHoldExpiry(address, state, watchdog);
        this.refreshIdleWatchdog(address, watchdog.generation, worker);
      }
      return;
    }
    if (event.phase === "retry_end") {
      clearRetry();
      pulse(false);
      return;
    }
    if (event.phase === "model_start") {
      clearRetry();
      state.modelPhase = "started";
      pulse(false);
      return;
    }
    if (event.phase === "model_progress") {
      state.modelPhase = "progress";
      pulse(true);
      return;
    }
    clearRetry();
    state.modelPhase = "ended";
    pulse(false);
  }

  private onToolLifecycle(address: string, worker: WorkerTransport, event: WorkerToolLifecycleEvent): void {
    let tools = this.toolLifecycles.get(address);
    const watchdog = this.watchdogs.get(address);
    if (!tools || tools.worker !== worker) {
      tools = { worker, ...(watchdog ? { watchdogGeneration: watchdog.generation } : {}), calls: new Map() };
      this.toolLifecycles.set(address, tools);
    }
    if (watchdog) {
      if (tools.watchdogGeneration === undefined) tools.watchdogGeneration = watchdog.generation;
      if (tools.watchdogGeneration !== watchdog.generation || watchdog.worker !== worker) return;
    } else if (tools.watchdogGeneration !== undefined) {
      return;
    }

    if (event.phase === "start") {
      if (!tools.calls.has(event.toolCallId)) tools.calls.set(event.toolCallId, { toolName: event.toolName });
    } else {
      if (!tools.calls.has(event.toolCallId)) return;
      tools.calls.delete(event.toolCallId);
    }
    if (watchdog) this.refreshIdleWatchdog(address, watchdog.generation, worker);
  }

  private async expireWorker(
    address: string,
    generation: number,
    code: string,
    expectedWorker?: WorkerTransport,
    expectedIdleGeneration?: number,
  ): Promise<void> {
    const entry = this.watchdogs.get(address);
    if (!entry || entry.generation !== generation || this.disposed) return;
    const worker = expectedWorker ?? entry.worker;
    if (entry.worker !== worker || this.workers.get(address) !== worker) return;
    const tools = this.toolLifecycles.get(address);
    const activeCalls = tools?.worker === worker && tools.watchdogGeneration === generation ? tools.calls : new Map();
    if (code === "LIFECYCLE_IDLE_TIMEOUT") {
      if (expectedIdleGeneration === undefined
        || entry.idleGeneration !== expectedIdleGeneration
        || !entry.idle) return;
      if (activeCalls.size > 0) {
        this.refreshIdleWatchdog(address, generation, worker);
        return;
      }
    }

    // Claim the generation synchronously before cleanup awaits. Routing is
    // detached by the one cleanup lease, while active capacity remains held.
    this.clearWatchdog(address);
    const record = this.records.get(address);
    if (!record) return;
    record.state = "failed";
    this.interruptRecordWork(record);
    const now = Date.now();
    const activeTools = [...activeCalls].slice(0, 8).map(([id, call]) =>
      `${truncateText(call.toolName.replace(/\s+/g, " "), 80)}:${truncateText(id.replace(/\s+/g, " "), 80)}`);
    const elapsed = code === "LIFECYCLE_IDLE_TIMEOUT"
      ? `elapsedIdleMs=${Math.max(0, now - entry.lastIdleAt)}`
      : `elapsedRunMs=${Math.max(0, now - entry.startedAt)}`;
    record.failure = `${code}: lifecycle watchdog expired (generation=${generation}; ${elapsed}; activeToolCount=${activeCalls.size}${activeTools.length > 0 ? `; activeTools=${activeTools.join(",")}` : ""})`;
    record.currentActivity = record.failure;
    record.updatedAt = nowIso();
    const lease = this.beginWorkerCleanup(address, worker, code, "failed");
    await this.persistRegistry();
    await this.ensureTerminalChildBlockers(record);
    this.options.mainAdapter.notifyFailure(`${address}: ${record.failure}`);
    try {
      await this.waitForCleanup(lease, lifecycleDuration(record.lifecycle.abortTimeoutMs, record.lifecycle.disposeTimeoutMs));
    } catch {
      // The cleanup observer persists a sticky quarantine and continues to own
      // late settlement. Timeout is deliberately not treated as cancellation.
    }
    this.publish();
  }

  private liveActiveTools(address: string): string[] | undefined {
    const worker = this.workers.get(address);
    if (!worker) return undefined;
    try {
      return [...worker.getSnapshot().activeTools];
    } catch {
      return undefined;
    }
  }

  private syncWorker(address: string, worker: WorkerTransport): void {
    const current = this.records.get(address);
    if (!current) return;
    try {
      const snapshot = worker.getSnapshot().record;
      current.sessionFile = worker.getSessionFile();
      current.effort = snapshot.effort;
      current.usage = snapshot.usage;
      current.activity = snapshot.activity.slice(-40).map((item) => ({
        ...item,
        summary: item.kind === "error" || item.kind === "status"
          ? safeErrorSummary(item.summary)
          : item.summary,
      }));
      current.lastActivityAt = snapshot.lastActivityAt;
      const latest = current.activity.at(-1);
      current.currentActivity = snapshot.currentActivity === snapshot.activity.at(-1)?.summary
        ? latest?.summary
        : snapshot.currentActivity;
      current.work = snapshot.work ? clone(snapshot.work) : current.work;
      current.updatedAt = nowIso();
    } catch {
      // The worker may emit while start is still constructing its session.
    }
  }

  private terminalFailureRecovery(record: AgentRecord): string {
    const open = this.mailStore.list().filter((email) => email.to === record.address
      && email.kind === "request"
      && email.requiresResponse
      && email.deliveryState === "delivered"
      && !email.answeredAt).length;
    const obligation = open === 0
      ? "No delivered requests remain unanswered."
      : `${open} delivered request${open === 1 ? "" : "s"} remain${open === 1 ? "s" : ""} unanswered.`;
    const effects = currentBatchHasEffectfulWork(record.work)
      ? "Current batch includes mutation/shell/custom work; effects may exist. Inspect Work and Conversation before explicit same-identity restart."
      : "No mutation/shell/custom effect is recorded in the current work ledger; this is not proof of pre-tool failure. Inspect Conversation before explicit same-identity restart.";
    return `Terminal worker run failure · ${record.provider}/${record.modelId} · provider/network cause may be external or unclear. ${obligation} ${effects} Do not redelegate this possible-effect scope while the original obligation remains open.`;
  }

  private onWorkerEvent(address: string, worker: WorkerTransport, event: WorkerEvent): void {
    if (this.disposed || this.workers.get(address) !== worker) return;
    const record = this.records.get(address);
    if (!record) return;
    if (event.type === "tool_lifecycle") {
      this.onToolLifecycle(address, worker, event);
      return;
    }
    if (event.type === "run_liveness") {
      this.onRunLiveness(address, worker, event);
      return;
    }
    this.syncWorker(address, worker);
    if (event.type === "activity" || event.type === "work") this.touchWatchdog(address);
    if (event.type === "state" && event.state && record.state !== "failed" && record.state !== "stopped") {
      record.state = event.state;
    }
    if (event.type === "failure" && event.error) {
      const summary = safeErrorSummary(event.error);
      const shouldNotify = record.state !== "failed" || record.failure !== summary;
      record.state = "failed";
      this.interruptRecordWork(record);
      record.failure = summary;
      record.currentActivity = `Failed: ${summary}`;
      record.updatedAt = nowIso();
      const lease = this.beginWorkerCleanup(address, worker, "WORKER_FAILURE", "failed");
      swallow(this.trackInFlight(this.waitForCleanup(
        lease,
        lifecycleDuration(record.lifecycle.abortTimeoutMs, record.lifecycle.disposeTimeoutMs),
      ).catch(() => undefined), `failure-cleanup:${address}`));
      swallow(this.trackInFlight(this.ensureTerminalChildBlockers(record), `terminal-child-blockers:${address}`));
      if (shouldNotify) this.options.mainAdapter.notifyFailure(`${address}: ${summary}\n${this.terminalFailureRecovery(record)}`);
      this.publish();
      return;
    }
    record.updatedAt = nowIso();
    // Completed work is important derived cache state. Coalesce siblings that
    // finish together; active starts stay live through snapshots without a write storm.
    if (event.type === "work" && event.workItem && event.workItem.status !== "running") {
      const prior = this.pendingWorkPersists.get(address); if (prior) clearTimeout(prior);
      const timer = setTimeout(() => {
        this.pendingWorkPersists.delete(address);
        if (!this.disposed) swallow(this.trackInFlight(this.persistRegistry(), `work-persist:${address}`));
      }, runtimeSafeDelay(25));
      timer.unref?.(); this.pendingWorkPersists.set(address, timer);
    }
    // SdkWorker emits its failed state immediately before the richer failure
    // event. Persist the latter atomically so readers never observe a terminal
    // failed record with its failure cause missing.
    if ((event.type === "state" && event.state !== "failed") || event.type === "settled") {
      swallow(this.trackInFlight(this.persistRegistry(), `event-persist:${address}`));
    }
    this.publish();
    if (event.type === "settled") {
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      this.queueWorkerSettlement(address, worker);
    }
  }

  private invalidateSettlement(worker: WorkerTransport): void {
    const settlement = this.settlements.get(worker);
    if (settlement) settlement.invalidated = true;
  }

  private async joinSettlement(worker: WorkerTransport): Promise<void> {
    const settlement = this.settlements.get(worker);
    if (!settlement) return;
    await settlement.operation.catch(() => undefined);
  }

  private settlementCurrent(settlement: SettlementLease): boolean {
    return !this.disposed
      && !settlement.invalidated
      && this.settlements.get(settlement.worker) === settlement
      && this.workers.get(settlement.address) === settlement.worker
      && this.workerGenerations.get(settlement.worker) === settlement.workerGeneration;
  }

  private queueWorkerSettlement(address: string, worker: WorkerTransport): void {
    const existing = this.settlements.get(worker);
    if (existing) {
      existing.pending = true;
      return;
    }
    const settlement: SettlementLease = {
      address,
      worker,
      workerGeneration: this.workerGeneration(worker, address),
      invalidated: false,
      pending: false,
      operation: undefined as never,
    };
    this.settlements.set(worker, settlement);
    settlement.operation = this.onWorkerSettled(settlement).finally(() => {
      if (this.settlements.get(worker) !== settlement) return;
      this.settlements.delete(worker);
      this.publish();
      if (settlement.pending && !settlement.invalidated && !this.disposed && this.workers.get(address) === worker) {
        this.queueWorkerSettlement(address, worker);
      }
    });
    swallow(this.trackInFlight(settlement.operation, `settlement:${address}`));
  }

  private async routeToWorker(envelope: EmailEnvelope, worker: WorkerTransport): Promise<void> {
    const record = this.records.get(envelope.to);
    const snapshot = worker.getSnapshot();
    if (snapshot.record.state === "stopped") return;
    const dependencyResult = envelope.kind === "reply"
      && Boolean(envelope.inReplyTo)
      && this.outgoingDependencies(envelope.to).some((request) => request.id === envelope.inReplyTo);
    if (record && !dependencyResult && this.outgoingDependencies(envelope.to).length > 0) {
      if (!snapshot.isStreaming) await this.parkWorker(envelope.to, record);
      return;
    }
    if (snapshot.isStreaming) {
      if (envelope.priority === "high") {
        // Requests are marked delivered before steering so the worker's own
        // fetch_emails sees them immediately; replies commit their answer only
        // after steer acceptance so a rejection still releases the reservation.
        if (envelope.kind === "request") await this.mailStore.markDelivered([envelope.id]);
        if (record && !this.exactWorkerAdmissionCurrent(envelope.to, record, worker)) return;
        try {
          if (record && !this.exactWorkerAdmissionCurrent(envelope.to, record, worker)) return;
          await bounded(worker.steer(formatEmail(envelope)), record?.lifecycle.promptAcceptanceTimeoutMs ?? this.options.config.lifecycle.promptAcceptanceTimeoutMs, "LIFECYCLE_PROMPT_ACCEPTANCE_TIMEOUT");
          this.touchWatchdog(envelope.to);
        } catch (error) {
          if (error instanceof LifecycleTimeoutError) {
            if (!this.watchdogs.has(envelope.to)) this.startWatchdog(envelope.to);
            await this.expireWorker(envelope.to, this.watchdogs.get(envelope.to)!.generation, error.code);
          }
          throw error;
        }
        if (envelope.kind !== "request") await this.mailStore.markDelivered([envelope.id]);
      }
      return;
    }
    await this.schedule(envelope.to);
  }

  private enqueueStart(address: string): void {
    if (!this.pendingStarts.includes(address)) this.pendingStarts.push(address);
    const record = this.records.get(address);
    if (record && !["stopped", "failed", "archived"].includes(record.state)) record.state = "queued";
  }

  private selectBatch(
    queued: readonly EmailEnvelope[],
    maxBytes = this.options.config.maxBatchBytes,
    maxLines = Number.MAX_SAFE_INTEGER,
  ): EmailEnvelope[] {
    const selected: EmailEnvelope[] = [];
    for (const email of queued) {
      if (selected.length >= this.options.config.maxBatchMessages) break;
      const candidate = [...selected, email];
      const formatted = formatEmailBatch(candidate);
      if (byteLength(formatted) > maxBytes || formatted.split("\n").length > maxLines) break;
      selected.push(email);
    }
    return selected;
  }

  fetchUnansweredBatch(addressInput: string): { emails: EmailEnvelope[]; total: number } {
    const all = this.fetchUnanswered(addressInput);
    const record = this.records.get(addressInput.trim().toLowerCase());
    const modelBytes = record
      ? conservativeModelEnvelopeBudget(this.catalog.resolveBound({ provider: record.provider, modelId: record.modelId }))
      : this.toolResultByteLimit;
    return {
      emails: this.selectBatch(all, Math.min(this.toolResultByteLimit, modelBytes), MAIL_TOOL_BATCH_LINES),
      total: all.length,
    };
  }

  private pendingRank(address: string, now = Date.now()): [number, string, string] {
    const mail = [...this.mailStore.unanswered(address), ...this.mailStore.queued(address)]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const oldest = mail[0]?.createdAt ?? "9999";
    const aged = mail.some((email) => now - Date.parse(email.createdAt) >= 30_000);
    const high = mail.some((email) => email.priority === "high");
    return [aged || high ? 0 : 1, oldest, address];
  }

  private takeNextPending(): string | undefined {
    if (this.pendingStarts.length === 0) return undefined;
    const ranked = this.pendingStarts
      .map((address, index) => ({ address, index, rank: this.pendingRank(address) }))
      .sort((left, right) => left.rank[0] - right.rank[0]
        || left.rank[1].localeCompare(right.rank[1])
        || left.rank[2].localeCompare(right.rank[2]))[0];
    if (!ranked) return undefined;
    this.pendingStarts.splice(ranked.index, 1);
    return ranked.address;
  }

  private async schedule(address: string): Promise<void> {
    if (this.disposed || this.scheduling.has(address) || this.active.has(address)) return;
    const worker = this.workers.get(address);
    const record = this.records.get(address);
    if (!worker || !record || ["stopped", "failed"].includes(record.state)) return;
    const dependencies = this.outgoingDependencies(address);
    const dependencyReplies = this.queuedDependencyReplies(address);
    if (dependencies.length > 0 && dependencyReplies.length === 0) {
      await this.parkWorker(address, record);
      return;
    }
    const pending = dependencies.length > 0 ? dependencyReplies : this.mailStore.queued(address);
    const modelBytes = conservativeModelEnvelopeBudget(
      this.catalog.resolveBound({ provider: record.provider, modelId: record.modelId }),
    );
    const queued = this.selectBatch(pending, Math.min(this.options.config.maxBatchBytes, modelBytes));
    if (queued.length === 0) {
      const oversized = pending[0];
      if (oversized) {
        const error = `Formatted email exceeds the ${this.options.config.maxBatchBytes}-byte delivery limit.`;
        await this.failEnvelope(oversized, error);
        this.options.mainAdapter.notifyFailure(`${oversized.id} could not be delivered to ${address}: ${error}`);
        this.scheduleMailMaintenance();
        swallow(this.trackInFlight(this.schedule(address), `schedule:${address}`));
      }
      return;
    }
    if (this.active.size >= this.options.config.maxConcurrent) {
      this.enqueueStart(address);
      await this.persistRegistry();
      this.publish();
      return;
    }

    this.scheduling.add(address);
    this.active.add(address);
    this.setEpochRunSlot(record, true);
    record.state = "running";
    record.currentActivity = `Receiving ${queued.length} email${queued.length === 1 ? "" : "s"}`;
    record.updatedAt = nowIso();
    this.publish();
    // Requests are marked delivered before the prompt so a fast worker sees
    // them in fetch_emails from the first tool call of the run; a rejected
    // prompt fails them again below. Replies commit their answer only after
    // prompt acceptance so a rejection still releases the reservation.
    const requestIds = queued.filter((email) => email.kind === "request").map((email) => email.id);
    const replyIds = queued.filter((email) => email.kind !== "request").map((email) => email.id);
    let finishDependencyDelivery: (() => void) | undefined;
    let dependencyDelivery: Promise<void> | undefined;
    if (replyIds.length > 0) {
      const previous = this.dependencyDeliveryTransitions.get(address) ?? Promise.resolve();
      let resolveDelivery!: () => void;
      const current = new Promise<void>((resolve) => { resolveDelivery = resolve; });
      dependencyDelivery = previous.then(() => current);
      this.dependencyDeliveryTransitions.set(address, dependencyDelivery);
      finishDependencyDelivery = resolveDelivery;
    }
    try {
      // The exact generation/run-slot claim is durable before any Pi prompt can
      // be admitted. The prompt acceptance deadline does not move this boundary.
      await this.persistRegistry();
      if (requestIds.length > 0) await this.mailStore.markDelivered(requestIds);
      if (!this.exactWorkerAdmissionCurrent(address, record, worker)) return;
      await bounded(worker.prompt(formatEmailBatch(queued)), record.lifecycle.promptAcceptanceTimeoutMs, "LIFECYCLE_PROMPT_ACCEPTANCE_TIMEOUT");
      if (this.disposed || this.workers.get(address) !== worker) return;
      this.startWatchdog(address);
      if (replyIds.length > 0) await this.mailStore.markDelivered(replyIds);
      this.syncWorker(address, worker);
      await this.persistRegistry();
    } catch (error) {
      if (this.disposed || this.workers.get(address) !== worker) return;
      if (error instanceof LifecycleTimeoutError) {
        // Requests already delivered remain open; replies remain queued/reserved for recovery.
        await this.expireWorker(address, this.watchdogs.get(address)?.generation ?? -1, error.code);
        if (this.workers.get(address) === worker) {
          this.startWatchdog(address);
          await this.expireWorker(address, this.watchdogs.get(address)!.generation, error.code);
        }
        return;
      }
      for (const email of queued) {
        if (email.kind === "reply") continue;
        if (!this.isMainIdentity(email.from) && email.kind === "request") continue;
        await this.failEnvelope(email, errorMessage(error));
      }
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      this.active.delete(address);
      this.setEpochRunSlot(record, false);
      record.state = "failed";
      record.failure = errorMessage(error);
      record.updatedAt = nowIso();
      await this.persistRegistry();
      await this.ensureTerminalChildBlockers(record);
      this.options.mainAdapter.notifyFailure(`${address} could not start: ${record.failure}`);
      this.pump();
    } finally {
      finishDependencyDelivery?.();
      if (dependencyDelivery && this.dependencyDeliveryTransitions.get(address) === dependencyDelivery) {
        this.dependencyDeliveryTransitions.delete(address);
      }
      this.scheduling.delete(address);
      this.publish();
      if (!this.disposed && this.workers.get(address) !== worker && this.mailStore.queued(address).length > 0) {
        swallow(this.trackInFlight(this.schedule(address), `schedule:${address}`));
      }
    }
  }

  private async resumeEnforcement(address: string): Promise<void> {
    if (this.disposed || this.active.has(address)) return;
    const worker = this.workers.get(address);
    const record = this.records.get(address);
    const outstanding = this.fetchUnanswered(address);
    if (!worker || !record || outstanding.length === 0 || ["stopped", "failed"].includes(record.state)) return;
    if (this.outgoingDependencies(address).length > 0) {
      await this.parkWorker(address, record);
      return;
    }
    if (this.active.size >= this.options.config.maxConcurrent) {
      this.enqueueStart(address);
      return;
    }
    this.active.add(address);
    this.setEpochRunSlot(record, true);
    record.state = "running";
    record.enforcementAttempts += 1;
    try {
      await this.persistRegistry();
      if (!this.exactWorkerAdmissionCurrent(address, record, worker)) return;
      await bounded(worker.prompt(enforcementPrompt(outstanding.length, record.enforcementAttempts > 1), { newBatch: false }), record.lifecycle.promptAcceptanceTimeoutMs, "LIFECYCLE_PROMPT_ACCEPTANCE_TIMEOUT");
      if (this.disposed || this.workers.get(address) !== worker) return;
      this.startWatchdog(address);
      await this.persistRegistry();
    } catch (error) {
      if (this.disposed || this.workers.get(address) !== worker) return;
      if (error instanceof LifecycleTimeoutError) {
        this.startWatchdog(address);
        await this.expireWorker(address, this.watchdogs.get(address)!.generation, error.code);
        return;
      }
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      this.active.delete(address);
      this.setEpochRunSlot(record, false);
      record.state = "failed";
      record.failure = errorMessage(error);
      await this.persistRegistry();
      this.options.mainAdapter.notifyFailure(`${address} could not resume unanswered email: ${record.failure}`);
      this.pump();
    } finally {
      this.publish();
    }
  }

  private async onWorkerSettled(settlement: SettlementLease): Promise<void> {
    const { address, worker } = settlement;
    if (!this.settlementCurrent(settlement)) return;
    let record = this.records.get(address);
    try {
      if (!record || record.state === "stopped" || record.state === "failed") return;
      if (!this.settlementCurrent(settlement)) return;
      this.syncWorker(address, worker);
      if (!this.settlementCurrent(settlement)) return;
      this.interruptRecordWork(record);
      if (this.queuedDependencyReplies(address).length > 0) {
        this.active.delete(address);
        this.setEpochRunSlot(record, false);
        record.state = "queued";
        record.currentActivity = "Receiving a completed child dependency";
        record.updatedAt = nowIso();
        await this.persistRegistry();
        if (!this.settlementCurrent(settlement)) return;
        swallow(this.trackInFlight(this.schedule(address), `schedule:${address}`));
        this.pump();
        return;
      }
      if (this.outgoingDependencies(address).length > 0) {
        await this.parkWorker(address, record);
        return;
      }
      const outstanding = this.fetchUnanswered(address);
      if (outstanding.length > 0) {
        record = this.records.get(address);
        if (!record || !this.settlementCurrent(settlement)) return;
        if (record.enforcementAttempts < this.options.config.responseReminderLimit) {
          if (!this.settlementCurrent(settlement)) return;
          record.enforcementAttempts += 1;
          record.state = "running";
          record.currentActivity = `Answering ${outstanding.length} required email${outstanding.length === 1 ? "" : "s"}`;
          if (!this.settlementCurrent(settlement)) return;
          await bounded(worker.prompt(enforcementPrompt(outstanding.length, record.enforcementAttempts > 1), { newBatch: false }), record.lifecycle.promptAcceptanceTimeoutMs, "LIFECYCLE_PROMPT_ACCEPTANCE_TIMEOUT");
          if (!this.settlementCurrent(settlement)) return;
          this.startWatchdog(address);
          await this.persistRegistry();
          if (!this.settlementCurrent(settlement)) return;
          return;
        }
        if (!this.settlementCurrent(settlement)) return;
        this.clearWatchdog(address);
        this.clearToolLifecycle(address, worker);
        record.state = "failed";
        record.failure = `Stopped with ${outstanding.length} unanswered email(s) after ${record.enforcementAttempts} reminder(s).`;
        this.active.delete(address);
        this.setEpochRunSlot(record, false);
        await this.persistRegistry();
        if (!this.settlementCurrent(settlement)) return;
        await this.ensureTerminalChildBlockers(record);
        if (!this.settlementCurrent(settlement)) return;
        this.options.mainAdapter.notifyFailure(`${address}: ${record.failure}`);
        this.pump();
        return;
      }

      record = this.records.get(address);
      if (!record || !this.settlementCurrent(settlement)) return;
      record.enforcementAttempts = 0;
      record.state = "idle";
      record.failure = undefined;
      record.currentActivity = "Idle";
      record.updatedAt = nowIso();
      this.active.delete(address);
      this.setEpochRunSlot(record, false);
      await this.persistRegistry();
      if (!this.settlementCurrent(settlement)) return;
      if (this.mailStore.queued(address).length > 0) {
        swallow(this.trackInFlight(this.schedule(address), `schedule:${address}`));
      }
      this.pump();
    } catch (error) {
      if (!this.settlementCurrent(settlement)) return;
      if (error instanceof LifecycleTimeoutError) {
        this.startWatchdog(address);
        await this.expireWorker(address, this.watchdogs.get(address)!.generation, error.code);
        return;
      }
      if (!this.settlementCurrent(settlement)) return;
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      record = this.records.get(address);
      if (record && this.settlementCurrent(settlement)) {
        record.state = "failed";
        record.failure = errorMessage(error);
        record.updatedAt = nowIso();
        this.active.delete(address);
        this.setEpochRunSlot(record, false);
      }
      if (!this.settlementCurrent(settlement)) return;
      await this.persistRegistry();
      if (!this.settlementCurrent(settlement)) return;
      this.options.mainAdapter.notifyFailure(`${address} settlement failed: ${errorMessage(error)}`);
      this.pump();
    }
  }

  private admitPendingAddress(address: string): void {
    if (this.pendingAdmissions.has(address)) return;
    this.pendingAdmissions.add(address);
    const operation = this.withAddressOperation(address, async () => {
      const record = this.records.get(address);
      if (!record || ["stopped", "failed", "archived"].includes(record.state)) return;
      let worker = this.workers.get(address);
      if (!worker) {
        worker = await this.createWorker(this.resolveExistingRecord(record), record, this.lifecycleGeneration);
      }
      if (this.queuedDependencyReplies(address).length > 0) await this.schedule(address);
      else if (this.outgoingDependencies(address).length > 0) await this.parkWorker(address, record);
      else if (this.fetchUnanswered(address).length > 0) await this.resumeEnforcement(address);
      else if (this.mailStore.queued(address).length > 0) await this.schedule(address);
      else this.syncWorker(address, worker);
    });
    void operation.finally(() => {
      this.pendingAdmissions.delete(address);
      if (!this.disposed) this.pump();
    }).catch(() => undefined);
  }

  private pump(): void {
    while (this.active.size < this.options.config.maxConcurrent && this.pendingStarts.length > 0) {
      const address = this.takeNextPending();
      if (!address) break;
      this.admitPendingAddress(address);
    }
  }

  async stop(addressInput: string): Promise<void> {
    const address = addressInput.trim().toLowerCase();
    await this.withAddressOperation(address, async () => {
      const worker = this.workers.get(address);
      const record = this.records.get(address);
      if (!record) throw new Error(`Unknown agent ${address}.`);
      if (record.state === "archived") throw new Error(`Agent ${address} is archived.`);
      if (!worker) {
        this.assertNoCleanupQuarantine(address);
        this.active.delete(address);
        this.setEpochRunSlot(record, false);
        record.state = "stopped";
        record.currentActivity = "Stopped by user";
        record.updatedAt = nowIso();
        await this.persistRegistry();
        this.pump();
        this.publish();
        return;
      }
      const lease = this.beginWorkerCleanup(address, worker, "MANUAL_STOP", "stopped");
      await this.joinSettlement(worker);
      await this.waitForCleanup(lease, lifecycleDuration(record.lifecycle.abortTimeoutMs, record.lifecycle.disposeTimeoutMs));
      this.assertActive();
    });
  }

  async restart(addressInput: string): Promise<void> {
    const address = addressInput.trim().toLowerCase();
    await this.withAddressOperation(address, async () => {
      const record = this.records.get(address);
      if (!record) throw new Error(`Unknown agent ${address}.`);
      this.assertNoCleanupQuarantine(address);
      const parsed = this.resolveExistingRecord(record);
      if (!this.activationLeases.has(address)) {
        if (this.activeIdentityCount() >= this.options.config.maxAgents) {
          throw new Error(this.capacityFullDiagnostic());
        }
        this.activationLeases.add(address);
      }
      const old = this.workers.get(address);
      if (old) {
        const lease = this.beginWorkerCleanup(address, old, "MANUAL_RESTART", "paused");
        await this.joinSettlement(old);
        await this.waitForCleanup(lease, lifecycleDuration(record.lifecycle.abortTimeoutMs, record.lifecycle.disposeTimeoutMs));
      }
      this.assertActive();
      record.state = "paused";
      this.interruptRecordWork(record);
      delete record.failure;
      record.enforcementAttempts = 0;
      await this.createWorker(parsed, record, this.lifecycleGeneration);
      if (this.queuedDependencyReplies(address).length > 0) await this.schedule(address);
      else if (this.outgoingDependencies(address).length > 0) await this.parkWorker(address, record);
      else if (this.fetchUnanswered(address).length > 0) await this.resumeEnforcement(address);
      else if (this.mailStore.queued(address).length > 0) await this.schedule(address);
      this.publish();
    });
  }

  async cancelRequest(requestIdInput: string, reasonInput: string): Promise<EmailEnvelope> {
    this.assertActive();
    const requestId = requestIdInput.trim();
    const reason = reasonInput.trim();
    if (!requestId) throw new Error("Request ID is required.");
    if (reason.length < 8) throw new Error("Cancellation reason must contain at least 8 characters.");
    if (byteLength(reason) > MAX_CANCELLATION_REASON_BYTES) {
      throw new Error(`Cancellation reason exceeds ${MAX_CANCELLATION_REASON_BYTES} UTF-8 bytes.`);
    }
    const initial = this.mailStore.get(requestId);
    if (!initial) throw new Error(`Unknown request ${requestId}.`);
    if (!initial.requiresResponse || initial.kind !== "request") {
      throw new Error(`${requestId} has no response obligation to cancel.`);
    }
    if (this.isMainIdentity(initial.to)) {
      throw new Error("Incoming main-thread requests must be answered, not administratively cancelled.");
    }

    return this.withAddressOperation(initial.to, async () => {
      const request = this.mailStore.get(requestId);
      if (!request) throw new Error(`Unknown request ${requestId}.`);
      if (request.answeredAt) throw new Error(`${requestId} was already answered by ${request.answeredBy}.`);
      if (request.replyReservedBy) throw new Error(`${requestId} already has reply ${request.replyReservedBy} pending delivery.`);
      const record = this.records.get(request.to);
      if (!record) throw new Error(`Request recipient ${request.to} has no registered agent.`);
      const worker = this.workers.get(request.to);
      const inactive = ["failed", "stopped", "paused", "archived"].includes(record.state)
        && !worker?.getSnapshot().isStreaming;
      if (!inactive) {
        throw new Error("Only requests assigned to an inactive recipient can be cancelled; stop the agent first.");
      }

      const cancelled = await this.mailStore.cancelRequest(requestId, this.mainAddress, reason);
      let parentWake: EmailEnvelope | undefined;
      await this.withMailAdmission(async () => {
        parentWake = await this.ensureCancellationWakeJournal(cancelled);
      });
      const summary = `Cancelled request ${requestId}: ${truncateText(reason.replace(/\s+/g, " "), 160)}`;
      record.activity.push({ at: cancelled.cancelledAt ?? nowIso(), kind: "status", summary });
      record.activity = record.activity.slice(-40);
      record.updatedAt = nowIso();
      try {
        await this.persistRegistry();
      } catch (error) {
        this.options.mainAdapter.notifyFailure(
          `Request ${requestId} was durably cancelled, but registry activity persistence failed: ${errorMessage(error)}`,
        );
      }
      if (parentWake) {
        try {
          await this.ensureWorker(parentWake.to, undefined, parentWake);
        } catch (error) {
          this.options.mainAdapter.notifyFailure(
            `Parent cancellation wake ${parentWake.id} remains queued for ${parentWake.to}: ${errorMessage(error)}`,
          );
        }
      }
      this.scheduleMailMaintenance();
      this.emitChange();
      this.publish();
      return cancelled;
    });
  }

  async archive(addressInput: string): Promise<void> {
    const address = addressInput.trim().toLowerCase();
    await this.withAddressOperation(address, async () => {
      const record = this.records.get(address);
      if (!record) throw new Error(`Unknown agent ${address}.`);
      this.assertNoCleanupQuarantine(address);
      if (record.state === "archived") return;
      const worker = this.workers.get(address);
      const blockers = this.classifyArchiveBlockers(address, record, worker);
      if (!this.archiveEligible(record, blockers)) throw new Error(this.archiveBlockedDiagnostic(blockers));
      if (worker) {
        const lease = this.beginWorkerCleanup(address, worker, "MANUAL_ARCHIVE", "archived");
        await this.joinSettlement(worker);
        await this.waitForCleanup(lease, lifecycleDuration(record.lifecycle.abortTimeoutMs, record.lifecycle.disposeTimeoutMs));
        this.assertActive();
        return;
      }
      this.assertActive();
      this.active.delete(address);
      this.setEpochRunSlot(record, false);
      const pendingIndex = this.pendingStarts.indexOf(address);
      if (pendingIndex >= 0) this.pendingStarts.splice(pendingIndex, 1);
      record.state = "archived";
      this.interruptRecordWork(record);
      this.activationLeases.delete(address);
      record.currentActivity = "Archived";
      record.updatedAt = nowIso();
      await this.persistRegistry();
      this.pump();
      this.publish();
    });
  }

  async clearFailure(addressInput: string): Promise<void> {
    const address = addressInput.trim().toLowerCase();
    await this.withAddressOperation(address, async () => {
      const record = this.records.get(address);
      if (!record) throw new Error(`Unknown agent ${address}.`);
      this.assertNoCleanupQuarantine(address);
      if (!["idle", "stopped", "archived"].includes(record.state)) {
        throw new Error("Failure can only be cleared while the agent is idle, stopped, or archived.");
      }
      delete record.failure;
      record.updatedAt = nowIso();
      await this.persistRegistry();
      this.publish();
    });
  }

  async setEffort(addressInput: string, effort: ThinkingLevel): Promise<void> {
    const address = addressInput.trim().toLowerCase();
    await this.withAddressOperation(address, async () => {
      const record = this.records.get(address);
      const worker = this.workers.get(address);
      if (!record || !worker) throw new Error(`Unknown or unavailable agent ${address}.`);
      if (this.active.has(address) || !worker.getSnapshot().isIdle) throw new Error("Effort can only be changed while the agent is idle.");
      worker.setEffort(effort);
      this.syncWorker(address, worker);
      await this.persistRegistry();
      this.publish();
    });
  }

  inspectAgent(addressInput: string, effortOverride?: ThinkingLevel): AgentInspection {
    this.assertActive();
    if (effortOverride !== undefined && !isThinkingLevel(effortOverride)) {
      throw new Error("Effort must be one of off, minimal, low, medium, high, xhigh, or max.");
    }
    const shape = parseSubagentAddressShape(addressInput);
    const existing = this.records.get(shape.address);
    const parsed = existing
      ? undefined
      : parseNewSubagentAddress(shape.address, this.catalog, this.mainRouting.preferredProvider);
    const address = existing?.address ?? parsed!.address;
    const name = existing?.name ?? parsed!.name;
    const record = this.records.get(address);
    if (record && effortOverride !== undefined) {
      throw new Error("An effort override can preview only a prospective unknown agent; omit effort for an existing identity.");
    }
    const profile = resolveAgentProfile(this.options.config, address, name);
    const tools = record?.tools ?? profile.tools;
    const activeTools = record ? this.liveActiveTools(address) : undefined;
    const effectiveTools = activeTools ?? tools;
    const holdsActivationLease = this.activationLeases.has(address);
    const archiveBlockers = this.classifyArchiveBlockers(address, record, this.workers.get(address));
    const cleanup = record?.cleanup
      ?? (this.cleanupQuarantines.get(address) ? this.cleanupDiagnostic(this.cleanupQuarantines.get(address)!) : undefined);
    return {
      address,
      exists: Boolean(record),
      wouldSpawn: !record,
      capacityAvailable: (!record || holdsActivationLease || this.routableRecords.has(address))
        && !cleanup
        && (holdsActivationLease || this.activeIdentityCount() < this.options.config.maxAgents),
      capacity: this.capacitySnapshot(),
      holdsActivationLease,
      modelId: record?.modelId ?? parsed!.model.id,
      provider: record?.provider ?? parsed!.model.provider,
      effort: record?.effort ?? effortOverride ?? profile.effort,
      role: name,
      tools: [...tools],
      ...(activeTools ? { activeTools } : {}),
      ...(record?.instructions ?? profile.instructions ? { instructions: record?.instructions ?? profile.instructions } : {}),
      writable: isConfiguredWritable(effectiveTools),
      canSpawn: false,
      state: record?.state ?? "new",
      ...(record?.currentActivity ? { currentActivity: record.currentActivity } : {}),
      queued: this.mailStore.queued(address).length,
      unanswered: archiveBlockers.incomingUnanswered.count,
      outgoingUnanswered: archiveBlockers.outgoingUnanswered.count,
      pendingReplies: archiveBlockers.pendingReplies.count,
      archiveEligible: this.archiveEligible(record, archiveBlockers),
      archiveBlockers,
      usage: clone(record?.usage ?? emptyUsage()),
      ...(record?.failure ? { failure: record.failure } : {}),
      ...(cleanup ? { cleanup: clone(cleanup) } : {}),
      providerReady: this.workers.has(address)
        ? "available"
        : (record && !this.routableRecords.has(address) ? "unavailable" : "unknown"),
      lifecycle: clone(record?.lifecycle ?? resolveLifecycle(this.options.config, address, name)),
    };
  }

  private claimCollection(envelope: EmailEnvelope): string | undefined {
    const requestId = envelope.inReplyTo;
    if (!requestId || (this.collectingRequestIds.get(requestId) ?? 0) === 0) return undefined;
    this.collectionClaims.set(requestId, (this.collectionClaims.get(requestId) ?? 0) + 1);
    return requestId;
  }

  private releaseCollectionClaim(requestId: string): void {
    const count = this.collectionClaims.get(requestId) ?? 0;
    if (count <= 1) this.collectionClaims.delete(requestId);
    else this.collectionClaims.set(requestId, count - 1);
    this.emitChange();
  }

  private hasCollectionClaim(requestIds: readonly string[]): boolean {
    return requestIds.some((id) => (this.collectionClaims.get(id) ?? 0) > 0);
  }

  private waitItem(requestId: string): ReplyWaitItem {
    const request = this.mailStore.get(requestId);
    if (!request) return { requestId, state: "failed", error: `Unknown request ${requestId}.` };
    if (request.answeredAt) {
      const reply = this.mailStore.getReplyFor(requestId);
      return { requestId, state: "answered", request, ...(reply ? { reply } : {}) };
    }
    if (request.deliveryState === "failed") {
      return { requestId, state: "failed", request, error: request.error ?? "Request delivery failed." };
    }
    if (request.deliveryState === "cancelled") {
      const actor = request.cancelledBy ? ` by ${request.cancelledBy}` : "";
      const reason = request.cancellationReason ? `: ${request.cancellationReason}` : ".";
      return { requestId, state: "cancelled", request, error: `Request cancelled${actor}${reason}` };
    }
    if (!this.isMainIdentity(request.to)) {
      const record = this.records.get(request.to);
      if (record?.state === "failed") return { requestId, state: "failed", request, error: record.failure ?? "Agent failed." };
      if (record?.state === "stopped") return { requestId, state: "stopped", request, error: "Agent is stopped." };
      if (record?.state === "archived") return { requestId, state: "archived", request, error: "Agent is archived." };
      if (record?.state === "paused" && !this.workers.has(request.to)) {
        return { requestId, state: "paused", request, error: "Agent is paused by capacity and has no live worker." };
      }
    }
    return { requestId, state: "pending", request };
  }

  async waitForReplies(
    requestIdsInput: readonly string[],
    timeoutMs: number,
    collect = true,
    signal?: AbortSignal,
  ): Promise<WaitForRepliesResult> {
    this.assertActive();
    const requestIds = [...new Set(requestIdsInput)];
    if (requestIds.length === 0) throw new Error("At least one request ID is required.");
    if (requestIds.length > 32) throw new Error("At most 32 request IDs can be joined at once.");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) {
      throw new Error("Reply wait timeout must be from 0 to 300000 milliseconds.");
    }
    for (const id of requestIds) {
      const request = this.mailStore.get(id);
      if (!request) throw new Error(`Unknown request ${id}.`);
      if (!request.requiresResponse) throw new Error(`${id} is a reply and has no response obligation.`);
      if (!this.isMainIdentity(request.from)) throw new Error(`${id} was not sent by the main thread.`);
    }

    const incrementCollection = (): void => {
      if (!collect) return;
      for (const id of requestIds) this.collectingRequestIds.set(id, (this.collectingRequestIds.get(id) ?? 0) + 1);
    };
    const decrementCollection = (): void => {
      if (!collect) return;
      for (const id of requestIds) {
        const count = this.collectingRequestIds.get(id) ?? 0;
        if (count <= 1) this.collectingRequestIds.delete(id);
        else this.collectingRequestIds.set(id, count - 1);
      }
    };
    incrementCollection();

    return new Promise<WaitForRepliesResult>((resolve, reject) => {
      let settled = false;
      let requestedFinish: "timeout" | "abort" | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        this.changeListeners.delete(check);
        signal?.removeEventListener("abort", abort);
        decrementCollection();
      };
      const finish = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        const items = requestIds.map((id) => this.waitItem(id));
        cleanup();
        resolve({ complete: items.every((item) => item.state !== "pending"), timedOut, items });
      };
      const check = (): void => {
        // A sender that has claimed collection owns delivery until its journal
        // commit finishes. Timeout, abort, and shutdown wait for that boundary
        // so no reply is suppressed after its collector disappears.
        if (this.hasCollectionClaim(requestIds)) return;
        const terminal = requestIds.map((id) => this.waitItem(id)).every((item) => item.state !== "pending");
        if (requestedFinish === "abort") {
          finish(false);
          return;
        }
        if (requestedFinish === "timeout") {
          finish(!terminal);
          return;
        }
        if (this.disposed) {
          finish(!terminal);
          return;
        }
        if (terminal) finish(false);
      };
      const abort = (): void => {
        if (settled) return;
        requestedFinish = "abort";
        check();
      };
      this.changeListeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      timer = setTimeout(() => {
        requestedFinish = "timeout";
        check();
      }, runtimeSafeDelay(timeoutMs));
      check();
    });
  }

  getWorkItem(address: string, toolCallId: string): WorkItem | undefined {
    const work = this.records.get(address)?.work;
    const item = [...(work?.active ?? []), ...(work?.recent ?? [])].find((candidate) => candidate.toolCallId === toolCallId);
    return item ? clone(item) : undefined;
  }

  getSnapshot(): BrokerSnapshot {
    const agents = [...this.records.values()].map((source) => {
      const { work, activeTools: _derivedActiveTools, ...withoutWork } = source;
      const cleanup = source.cleanup
        ?? (this.cleanupQuarantines.get(source.address) ? this.cleanupDiagnostic(this.cleanupQuarantines.get(source.address)!) : undefined);
      const liveActiveTools = this.liveActiveTools(source.address);
      return {
        ...clone(withoutWork),
        ...(liveActiveTools ? { activeTools: liveActiveTools } : {}),
        ...(cleanup ? { cleanup: clone(cleanup) } : {}),
        ...(work ? { work: lightweightWork(work) } : {}),
      } as AgentRecord;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const unanswered = this.mailStore.list().filter((email) =>
      email.requiresResponse && !email.answeredAt && !email.replyReservedBy && email.deliveryState === "delivered").length;
    return {
      mainAddress: this.mainAddress,
      agents,
      unanswered,
      queuedMail: this.mailStore.countQueued(),
      capacity: this.capacitySnapshot(),
    };
  }

  private scheduleMailMaintenance(): void {
    if (this.disposed) return;
    const operation = this.mailStore.maintainIfNeeded(undefined, this.options.config.maxRetainedEmails).catch((error) => {
      this.options.mainAdapter.notifyFailure(`Mail journal maintenance failed: ${errorMessage(error)}`);
    });
    // Track the mutation itself, not its bookkeeping continuation.
    this.trackInFlight(operation, "mail-maintenance");
    swallow(operation);
  }

  private publish(): void {
    this.emitChange();
    if (!this.registry || this.disposed) return;
    this.options.mainAdapter.updateState(this.getSnapshot());
  }

  private async persistRegistry(force = false): Promise<void> {
    if (!this.registry || (!force && (this.lifecycle === "closing" || this.lifecycle === "closed"))) return;
    this.registry.agents = [...this.records.values()].map(clone);
    await this.registryStore.save(this.registry);
  }

  async shutdown(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const operation = this.close();
    this.closePromise = operation;
    return operation;
  }

  private async disposeOwnedWorkers(maximumTimeoutMs = Number.MAX_SAFE_INTEGER): Promise<void> {
    const committed = new Map(this.workers);
    const allWorkers = new Set<WorkerTransport>([
      ...committed.values(),
      ...this.provisionalWorkers,
      ...this.cleanupLeases.keys(),
    ]);
    const leases: WorkerCleanupLease[] = [];
    for (const worker of allWorkers) {
      const address = [...committed].find(([, candidate]) => candidate === worker)?.[0]
        ?? this.workerAddresses.get(worker);
      if (!address) continue;
      const record = this.records.get(address);
      if (record && !["stopped", "failed", "archived"].includes(record.state)) {
        this.syncWorker(address, worker);
        record.state = "paused";
        this.interruptRecordWork(record);
        record.updatedAt = nowIso();
      }
      leases.push(this.beginWorkerCleanup(address, worker, "BROKER_SHUTDOWN", "paused"));
    }
    await Promise.all([...allWorkers].map((worker) => this.joinSettlement(worker)));
    const results = await Promise.allSettled(leases.map((lease) => {
      const record = this.records.get(lease.address);
      const configured = lifecycleDuration(
        record?.lifecycle.abortTimeoutMs ?? this.options.config.lifecycle.abortTimeoutMs,
        record?.lifecycle.disposeTimeoutMs ?? this.options.config.lifecycle.disposeTimeoutMs,
      );
      return this.waitForCleanup(lease, Math.max(1, Math.min(maximumTimeoutMs, configured)));
    }));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, failures.map(errorMessage).join("; "));
  }

  private async releaseNamespaceLock(): Promise<void> {
    const current = this.namespaceLock;
    this.namespaceLock = undefined;
    await current?.release();
  }

  private async close(): Promise<void> {
    if (this.lifecycle === "closed") return;
    this.lifecycle = "closing";
    this.disposed = true;
    for (const timer of this.pendingWorkPersists.values()) clearTimeout(timer);
    this.pendingWorkPersists.clear();
    this.lifecycleGeneration += 1;
    this.emitChange();
    // Operations can reject as soon as `disposed` is visible; observe them
    // before any cleanup await so delayed callers do not trigger unhandled rejections.
    for (const operation of [...this.addressTails.values(), ...this.inFlightOperations]) operation.catch(() => undefined);

    const failures: unknown[] = [];
    const persistedCleanup = [...this.records.values()].find((record) => record.cleanup && !this.cleanupQuarantines.has(record.address));
    let sessionCleanupSettled = !persistedCleanup;
    if (persistedCleanup) failures.push(this.cleanupError(persistedCleanup.address));
    const shutdownMs = this.options.config.lifecycle.brokerShutdownTimeoutMs;
    const deadline = Date.now() + shutdownMs;
    const lockReleaseReserveMs = Math.min(50, Math.max(1, Math.floor(shutdownMs / 5)));
    const workRemaining = () => deadline - Date.now() - lockReleaseReserveMs;
    const runPhase = async (code: string, start: () => Promise<unknown>, detail?: string): Promise<void> => {
      let operation: Promise<unknown>;
      try { operation = start(); } catch (error) { failures.push(error); return; }
      // Observe late completion/rejection even when the global deadline wins.
      operation.catch(() => undefined);
      const available = workRemaining();
      if (available <= 0) {
        failures.push(new LifecycleTimeoutError(code, shutdownMs));
        sessionCleanupSettled = false;
        return;
      }
      try {
        await bounded(operation, available, code);
      } catch (error) {
        if (error instanceof LifecycleTimeoutError && error.code === code && detail) {
          failures.push(new LifecycleTimeoutError(code, error.timeoutMs, detail));
        } else failures.push(error);
        if (containsLifecycleTimeout(error)) {
          if (!(error instanceof LifecycleTimeoutError && error.code === code)) {
            failures.push(new LifecycleTimeoutError(code, Math.max(1, available), detail));
          }
          sessionCleanupSettled = false;
        }
        if (containsCleanupQuarantine(error)) sessionCleanupSettled = false;
      }
    };

    // Do not short-circuit: every phase is attempted or explicitly marked
    // unsettled under the one global deadline.
    await runPhase("LIFECYCLE_BROKER_SHUTDOWN_DISPOSE_TIMEOUT", () => this.disposeOwnedWorkers(Math.max(1, workRemaining())));
    if (this.initPromise) {
      // Initialization reports its own failure to its caller; shutdown only
      // needs to prove the operation has settled.
      await runPhase("LIFECYCLE_BROKER_SHUTDOWN_INIT_TIMEOUT", () => this.initPromise!.catch(() => undefined));
    }
    await runPhase("LIFECYCLE_BROKER_SHUTDOWN_DISPOSE_TIMEOUT", () => this.disposeOwnedWorkers(Math.max(1, workRemaining())));
    // Drain snapshots until removal callbacks have emptied both sets. New
    // maintenance cannot start after `disposed`; address/send operations that
    // were already queued may remove themselves while a prior snapshot waits.
    while (this.addressTails.size > 0 || this.inFlightOperations.size > 0) {
      const addressEntries = [...this.addressTails.entries()];
      const operationEntries = [...this.inFlightOperations];
      const barriers = [...addressEntries.map(([, promise]) => promise), ...operationEntries];
      const labels = [
        ...addressEntries.map(([address]) => `address:${address}`),
        ...operationEntries.map((operation) => this.operationLabels.get(operation) ?? "operation:unknown"),
      ];
      await runPhase(
        "LIFECYCLE_BROKER_SHUTDOWN_BARRIER_TIMEOUT",
        () => Promise.allSettled(barriers),
        `barriers: ${labels.join(", ")}`,
      );
      if (workRemaining() <= 0) break;
    }

    this.pendingStarts.splice(0);
    this.preparedWorkerRuntimes.clear();
    await runPhase("LIFECYCLE_BROKER_SHUTDOWN_PERSIST_TIMEOUT", () => this.persistRegistry(true));
    await runPhase("LIFECYCLE_BROKER_SHUTDOWN_FLUSH_TIMEOUT", () =>
      Promise.all([this.mailStore.flush(), this.registryStore.flush()]));

    // Namespace ownership is a safety lease, not merely cleanup. A timed-out
    // mutator may still write later, so retain ownership until process death.
    if (sessionCleanupSettled) {
      const releaseMs = Math.max(1, deadline - Date.now());
      try {
        await bounded(this.releaseNamespaceLock(), releaseMs, "LIFECYCLE_BROKER_SHUTDOWN_LOCK_TIMEOUT");
      } catch (error) {
        failures.push(error);
      }
    }
    this.lifecycle = "closed";
    this.emitChange();
    if (failures.length > 0) {
      throw new AggregateError(failures, failures.map(errorMessage).join("; "));
    }
  }
}
