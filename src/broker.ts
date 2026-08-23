import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ModelCatalog, parseSubagentAddress, parseSubagentAddressShape } from "./address.ts";
import { isThinkingLevel, resolveAgentProfile, resolveLifecycle } from "./config.ts";
import { createMailId } from "./id.ts";
import { MailStore } from "./mail-store.ts";
import { NamespaceLock } from "./namespace-lock.ts";
import { enforcementPrompt, formatEmail, formatEmailBatch, subagentPrompt } from "./prompts.ts";
import { RegistryStore } from "./registry-store.ts";
import { looksLikeReply, makeReplySubject, parseReplySubject } from "./reply.ts";
import { SlidingWindowRateLimiter } from "./rate-limit.ts";
import { MAIL_TOOL_BATCH_BYTES, MAIL_TOOL_BATCH_LINES } from "./tool-result.ts";
import type {
  AgentInspection,
  AgentRecord,
  BrokerOptions,
  BrokerRegistry,
  BrokerSnapshot,
  EmailEnvelope,
  ParsedAddress,
  ReplyWaitItem,
  SendEmailInput,
  SendEmailResult,
  LifecyclePolicy,
  WaitForRepliesResult,
  WorkerEvent,
  WorkerToolLifecycleEvent,
  WorkerTransport,
  WorkItem,
  AgentWorkState,
} from "./types.ts";
import { byteLength, clone, errorMessage, nowIso, truncateText } from "./util.ts";
import { emptyWorkState, interruptActive, recoverMutationWork } from "./work-ledger.ts";

export const MAX_CANCELLATION_REASON_BYTES = 1_024;

function emptyUsage(): AgentRecord["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function utf8Prefix(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

function boundedCompletionMessage(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffix = "\n\n[Automatic completion email truncated to the configured message limit.]";
  if (byteLength(suffix) >= maxBytes) return utf8Prefix(value, maxBytes);
  return `${utf8Prefix(value, maxBytes - byteLength(suffix))}${suffix}`;
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

function lightweightWork(work: AgentWorkState): AgentWorkState {
  return {
    nextBatchId: work.nextBatchId,
    ...(work.currentBatchId !== undefined ? { currentBatchId: work.currentBatchId } : {}),
    ...(work.batchStartedAt !== undefined ? { batchStartedAt: work.batchStartedAt } : {}),
    ...(work.batchEndedAt !== undefined ? { batchEndedAt: work.batchEndedAt } : {}),
    ...(work.recoveryError !== undefined ? { recoveryError: work.recoveryError } : {}),
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

class LifecycleTimeoutError extends Error {
  constructor(readonly code: string, readonly timeoutMs: number, detail?: string) {
    super(`${code}: lifecycle deadline exceeded after ${timeoutMs}ms${detail ? ` (${detail})` : ""}`);
    this.name = "LifecycleTimeoutError";
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LifecycleTimeoutError(code, timeoutMs)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    promise.catch(() => undefined);
  }
}

function containsLifecycleTimeout(error: unknown): boolean {
  if (error instanceof LifecycleTimeoutError) return true;
  return error instanceof AggregateError && error.errors.some(containsLifecycleTimeout);
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

interface ActiveToolCall {
  toolName: string;
  startedAt: string;
  lastProgressAt: string;
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
  private readonly addressTails = new Map<string, Promise<void>>();
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private readonly operationLabels = new WeakMap<Promise<unknown>, string>();
  private readonly activationLeases = new Set<string>();
  private readonly active = new Set<string>();
  private readonly pendingStarts: string[] = [];
  private readonly scheduling = new Set<string>();
  private readonly settling = new Set<string>();
  private readonly pendingSettlements = new Set<string>();
  private readonly globalRateLimiter: SlidingWindowRateLimiter;
  private readonly senderRateLimiters = new Map<string, SlidingWindowRateLimiter>();
  private readonly changeListeners = new Set<() => void>();
  private readonly collectingRequestIds = new Map<string, number>();
  private readonly collectionClaims = new Map<string, number>();
  private readonly pendingWorkPersists = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchdogs = new Map<string, WatchdogEntry>();
  private readonly toolLifecycles = new Map<string, ToolLifecycleState>();
  private watchdogGeneration = 0;
  private lifecycle: "new" | "initializing" | "active" | "closing" | "closed" = "new";
  private lifecycleGeneration = 0;
  private initPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private namespaceLock?: NamespaceLock;
  private disposed = false;

  constructor(private readonly options: BrokerOptions) {
    this.mailStore = new MailStore(join(options.namespaceDir, "mail.jsonl"));
    this.registryStore = new RegistryStore(join(options.namespaceDir, "registry.json"));
    this.catalog = new ModelCatalog(options.models, options.preferredProvider);
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
      this.registry = await this.registryStore.load(currentMain);
      this.checkpoint(generation);
      this.registry.mainAddress = currentMain;
      this.registry.mainAliases = [...new Set([
        ...this.registry.mainAliases.map((value) => value.toLowerCase()),
        ...this.options.mainAdapter.getAliases(),
        currentMain,
      ])];

      const startupFailures: string[] = [];
      for (const loaded of this.registry.agents) {
        const shape = parseSubagentAddressShape(loaded.address);
        const record = clone(loaded);
        record.address = shape.address;
        record.name = shape.name;
        record.taskSlug = shape.taskSlug;
        try {
          const parsed = parseSubagentAddress(shape.address, this.catalog);
          const profile = resolveAgentProfile(this.options.config, parsed.address, parsed.name);
          record.address = parsed.address;
          record.provider = parsed.model.provider;
          record.modelId = parsed.model.id;
          record.tools = profile.tools;
          record.canSpawn = profile.canSpawn;
          record.instructions = profile.instructions;
          if (["running", "spawning", "queued"].includes(record.state)) record.state = "paused";
          if (record.state !== "running") this.interruptRecordWork(record);
          this.routableRecords.add(record.address);
        } catch (error) {
          const profile = resolveAgentProfile(this.options.config, record.address, record.name);
          record.tools = profile.tools;
          record.canSpawn = profile.canSpawn;
          record.instructions = profile.instructions;
          const priorState = record.state;
          if (priorState !== "archived" && priorState !== "stopped") record.state = "failed";
          record.failure = `Model unavailable during restore: ${errorMessage(error)}`;
          record.currentActivity = record.failure;
          record.updatedAt = nowIso();
          if (priorState !== "archived") startupFailures.push(`${record.address}: ${record.failure}`);
        }
        this.records.set(record.address, record);
      }

      // Mail acceptance precedes first worker persistence. Recover a recipient
      // record when a crash leaves durable queued mail but no registry entry.
      for (const email of this.mailStore.list()) {
        if (email.deliveryState !== "queued" || this.isMainIdentity(email.to) || this.records.has(email.to)) continue;
        const shape = parseSubagentAddressShape(email.to);
        try {
          const parsed = parseSubagentAddress(shape.address, this.catalog);
          const record = this.makeRecord(
            parsed,
            email.lifecycleIntent ?? resolveLifecycle(this.options.config, parsed.address, parsed.name),
            email.effortIntent,
          );
          record.createdAt = email.createdAt;
          record.updatedAt = nowIso();
          record.state = "paused";
          this.records.set(record.address, record);
          this.routableRecords.add(record.address);
        } catch (error) {
          const profile = resolveAgentProfile(this.options.config, shape.address, shape.name);
          const record = this.makeUnavailableRecord(shape, email.createdAt, errorMessage(error));
          record.tools = profile.tools;
          record.canSpawn = profile.canSpawn;
          record.instructions = profile.instructions;
          this.records.set(record.address, record);
          startupFailures.push(`${record.address}: ${record.failure}`);
        }
      }

      // Recover durable mutation outcomes before provider startup or capacity filtering.
      for (const record of this.records.values()) {
        if (!record.sessionFile) { this.interruptRecordWork(record); continue; }
        try {
          const info = await stat(record.sessionFile);
          if (info.size > 20 * 1024 * 1024) throw new Error("session exceeds 20 MB recovery bound");
          const manager = SessionManager.open(record.sessionFile, join(this.options.namespaceDir, "sessions"), this.options.cwd);
          record.work = recoverMutationWork(manager.getBranch(), this.options.cwd, record.work ?? emptyWorkState());
        } catch (error) {
          record.work ??= emptyWorkState();
          this.interruptRecordWork(record);
          record.work.recoveryError = truncateText(errorMessage(error), 500);
        }
      }

      const registered = [...this.records.values()].filter((record) =>
        record.state !== "archived" && this.routableRecords.has(record.address));
      for (const record of registered.slice(0, this.options.config.maxAgents)) this.activationLeases.add(record.address);
      for (const record of registered.slice(this.options.config.maxAgents)) {
        record.state = "paused";
        this.interruptRecordWork(record);
        record.currentActivity = `Paused by maxAgents capacity (${this.options.config.maxAgents})`;
        record.updatedAt = nowIso();
      }
      await this.persistRegistry(true);
      this.checkpoint(generation);

      const restorable = [...this.records.values()]
        .filter((record) => this.activationLeases.has(record.address) && !["stopped", "failed", "archived"].includes(record.state));
      const restored = await Promise.allSettled(restorable.map(async (record) => {
        try {
          const parsed = parseSubagentAddress(record.address, this.catalog);
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
        if (!this.workers.has(record.address)) continue;
        if (this.mailStore.unanswered(record.address).length > 0) swallow(this.resumeEnforcement(record.address));
        else if (this.mailStore.queued(record.address).length > 0) swallow(this.schedule(record.address));
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
      await this.disposeOwnedWorkers();
      let releaseError: unknown;
      if (!cancelled) {
        try { await this.releaseNamespaceLock(); } catch (cleanupError) { releaseError = cleanupError; }
        this.lifecycle = "closed";
      }
      if (releaseError) {
        throw new AggregateError([error, releaseError], `Broker initialization and namespace-lock cleanup both failed.`);
      }
      throw error;
    }
  }

  private interruptRecordWork(record: AgentRecord): void {
    if (record.work?.active.length) interruptActive(record.work);
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

  private assertActive(): void {
    if (this.disposed || this.lifecycle !== "active") throw new Error("Email broker is shutting down or not ready.");
    this.requiredRegistry();
  }

  private activeIdentityCount(): number {
    return this.activationLeases.size;
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
    return this.requiredRegistry().mainAddress;
  }

  get modelIds(): string[] {
    return this.catalog.routableModelIds;
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

  async updateMainAddress(address: string): Promise<void> {
    this.assertActive();
    const normalized = address.toLowerCase();
    const registry = this.requiredRegistry();
    registry.mainAddress = normalized;
    registry.mainAliases = [...new Set([...registry.mainAliases, normalized])];
    await this.persistRegistry();
    this.publish();
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

  private validateDeliverySize(envelope: EmailEnvelope): void {
    const formatted = formatEmail(envelope);
    const byteLimit = this.toolResultByteLimit;
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
    if (this.workers.has(original.to)) swallow(this.resumeEnforcement(original.to));
  }

  send(senderInput: string, input: SendEmailInput): Promise<SendEmailResult> {
    const operation = this.sendInternal(senderInput, input);
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

  private async sendInternal(senderInput: string, input: SendEmailInput): Promise<SendEmailResult> {
    this.assertActive();
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
    let to = requestedTo;
    let initialEffort: ThinkingLevel | undefined;
    let initialLifecycle: LifecyclePolicy | undefined;
    if (!toMain) {
      parsed = parseSubagentAddress(requestedTo, this.catalog);
      to = parsed.address;
      if (this.sameIdentity(sender, to)) throw new Error("Sending email to yourself is not supported.");
      const existingRecord = this.records.get(to);
      if (input.effort !== undefined && existingRecord) {
        throw new Error(`Effort overrides are accepted only on the first delegation to an unknown address. ${to} already exists (${existingRecord.state}); omit effort and use its persisted value. Archived restoration also preserves its original effort.`);
      }
      if (input.lifecycle !== undefined && existingRecord) {
        throw new Error(`Lifecycle overrides are accepted only on the first delegation to an unknown address. ${to} already exists (${existingRecord.state}); omit lifecycle and use its persisted policy. Archived restoration also preserves its original policy.`);
      }
      initialEffort = existingRecord?.effort
        ?? input.effort
        ?? resolveAgentProfile(this.options.config, to, parsed.name).effort;
      initialLifecycle = existingRecord?.lifecycle ?? resolveLifecycle(this.options.config, to, parsed.name, input.lifecycle);
      const senderRecord = this.records.get(sender);
      if (senderRecord && !senderRecord.canSpawn && !this.records.has(to)) {
        throw new Error(`Agent ${sender} is not permitted to spawn new agents; reuse an existing address.`);
      }
      if (!this.activationLeases.has(to) && this.activeIdentityCount() >= this.options.config.maxAgents) {
        throw new Error(`Agent limit reached (${this.options.config.maxAgents}); archive or reuse an existing address.`);
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

    let answeredEmailId: string | undefined;
    if (reply) {
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
      answeredEmailId = original.id;
    }

    let acquiredLease = false;
    if (parsed && !this.activationLeases.has(to)) {
      if (this.activeIdentityCount() >= this.options.config.maxAgents) {
        throw new Error(`Agent limit reached (${this.options.config.maxAgents}); archive or reuse an existing address.`);
      }
      this.activationLeases.add(to);
      acquiredLease = true;
    }

    const envelope: EmailEnvelope = {
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
      ...(parsed && !this.records.has(to) ? {
        effortIntent: initialEffort!,
        lifecycleIntent: { ...initialLifecycle! },
      } : {}),
    };
    try {
      this.validateDeliverySize(envelope);
      await this.withAddressOperation(to, async () => {
        const currentWorker = this.workers.get(to);
        const steersImmediately = !toMain && input.priority === "high" && Boolean(currentWorker?.getSnapshot().isStreaming);
        if (!toMain && !steersImmediately) this.validateQueueCapacity(to, input);
        this.takeRateQuota(sender);
        if (answeredEmailId) await this.mailStore.reserveReply(envelope, answeredEmailId);
        else await this.mailStore.accept(envelope);
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
        const ensured = await this.ensureWorker(parsed!, envelope);
        spawned = ensured.spawned;
        disposition = ensured.disposition;
        recipientRecord = this.records.get(to);
      }
    } catch (error) {
      // Lifecycle failures retain accepted queued/open mail for restart and diagnosis.
      if (!(error instanceof LifecycleTimeoutError)) await this.failEnvelope(envelope, errorMessage(error));
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
        recipientEffort: recipientRecord.effort,
        recipientRole: recipientRecord.name,
        recipientTools: [...recipientRecord.tools],
        recipientState: recipientRecord.state,
        recipientLifecycle: { ...recipientRecord.lifecycle },
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

  private async ensureWorker(parsed: ParsedAddress, envelope: EmailEnvelope): Promise<{
    worker?: WorkerTransport;
    spawned: boolean;
    disposition: SendEmailResult["recipientDisposition"];
  }> {
    return this.withAddressOperation(parsed.address, async () => {
      const existingWorker = this.workers.get(parsed.address);
      if (existingWorker) {
        await this.routeToWorker(envelope, existingWorker);
        return { worker: existingWorker, spawned: false, disposition: "reused" as const };
      }
      const record = this.records.get(parsed.address);
      if (record?.state === "stopped") return { spawned: false, disposition: "stopped" as const };
      const restoringArchive = record?.state === "archived";
      if (!this.activationLeases.has(parsed.address)) {
        if (this.activeIdentityCount() >= this.options.config.maxAgents) {
          throw new Error(`Agent limit reached (${this.options.config.maxAgents}).`);
        }
        this.activationLeases.add(parsed.address);
      }
      const worker = await this.createWorker(
        parsed,
        record,
        this.lifecycleGeneration,
        envelope.lifecycleIntent,
        envelope.effortIntent,
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
      canSpawn: profile.canSpawn,
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
  ): AgentRecord {
    const failure = `Model unavailable during restore: ${reason}`;
    return {
      address: shape.address,
      name: shape.name,
      taskSlug: shape.taskSlug,
      provider: "unavailable",
      modelId: shape.modelId,
      effort: this.options.config.defaultEffort,
      tools: [],
      canSpawn: true,
      state: "failed",
      createdAt,
      updatedAt: nowIso(),
      currentActivity: failure,
      failure,
      enforcementAttempts: 0,
      lifecycle: resolveLifecycle(this.options.config, shape.address, shape.name),
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
  ): Promise<WorkerTransport> {
    const record = restored ?? this.makeRecord(parsed, lifecycleIntent, effortIntent);
    record.state = "spawning";
    delete record.failure;
    record.updatedAt = nowIso();
    this.records.set(record.address, record);
    // A newly accepted identity (and its lifecycle) is durable before provider startup.
    // Restored records were already loaded from durable registry state.
    if (!restored) await this.persistRegistry(true);
    const spawnStartedAt = Date.now();
    let worker: WorkerTransport;
    const factoryPromise = Promise.resolve(this.options.workerFactory(parsed.model));
    try {
      worker = await bounded(factoryPromise, record.lifecycle.spawnTimeoutMs, "LIFECYCLE_SPAWN_TIMEOUT");
    } catch (error) {
      // If a timed-out factory eventually returns a worker, dispose it without reopening capacity.
      swallow(factoryPromise.then((late) => bounded(late.dispose(), record.lifecycle.disposeTimeoutMs, "LIFECYCLE_DISPOSE_TIMEOUT")));
      if (!this.cancelled(generation)) {
        record.state = "failed";
        record.failure = errorMessage(error);
        record.updatedAt = nowIso();
        await this.persistRegistry();
        this.publish();
      }
      throw error;
    }
    if (this.cancelled(generation)) {
      await bounded(worker.dispose(), record.lifecycle.disposeTimeoutMs, "LIFECYCLE_DISPOSE_TIMEOUT").catch(() => undefined);
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
        sendEmail: (input) => this.send(record.address, input),
        fetchEmails: () => this.fetchUnansweredBatch(record.address),
      }), remainingSpawnMs, "LIFECYCLE_SPAWN_TIMEOUT");
      if (this.cancelled(generation)) throw new Error("Worker creation was cancelled by broker shutdown.");
      const previous = this.workers.get(record.address);
      if (previous && previous !== worker) throw new Error(`Agent ${record.address} already has a live worker.`);
      this.workers.set(record.address, worker);
      this.clearToolLifecycle(record.address);
      this.toolLifecycles.set(record.address, { worker, calls: new Map() });
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
      if (this.workerUnsubscribers.get(record.address) === unsubscribe) this.workerUnsubscribers.delete(record.address);
      if (!this.cancelled(generation)) {
        record.state = "failed";
        record.failure = errorMessage(error);
        record.updatedAt = nowIso();
      }
      await bounded(worker.dispose(), record.lifecycle.disposeTimeoutMs, "LIFECYCLE_DISPOSE_TIMEOUT").catch(() => undefined);
      if (!this.cancelled(generation)) {
        await this.persistRegistry();
        this.publish();
      }
      throw error;
    }
  }

  private clearWatchdog(address: string): void {
    const current = this.watchdogs.get(address);
    if (current?.run) clearTimeout(current.run);
    if (current?.idle) clearTimeout(current.idle);
    this.watchdogs.delete(address);
  }

  private clearToolLifecycle(address: string, worker?: WorkerTransport): void {
    const current = this.toolLifecycles.get(address);
    if (!worker || current?.worker === worker) this.toolLifecycles.delete(address);
  }

  private startWatchdog(address: string): void {
    const record = this.records.get(address);
    const worker = this.workers.get(address);
    if (!record || !worker) return;
    this.clearWatchdog(address);
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
    entry.run = setTimeout(
      () => swallow(this.expireWorker(address, generation, "LIFECYCLE_RUN_TIMEOUT", worker)),
      record.lifecycle.runTimeoutMs,
    );
    this.watchdogs.set(address, entry);
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
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = undefined;
    entry.idleGeneration += 1;
    if (tools.calls.size > 0) return;
    entry.lastIdleAt = Date.now();
    const idleGeneration = entry.idleGeneration;
    entry.idle = setTimeout(
      () => swallow(this.expireWorker(
        address,
        generation,
        "LIFECYCLE_IDLE_TIMEOUT",
        worker,
        idleGeneration,
      )),
      record.lifecycle.idleTimeoutMs,
    );
  }

  private touchWatchdog(address: string): void {
    const entry = this.watchdogs.get(address);
    if (!entry) return;
    this.refreshIdleWatchdog(address, entry.generation, entry.worker);
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
      if (!tools.calls.has(event.toolCallId)) {
        tools.calls.set(event.toolCallId, {
          toolName: event.toolName,
          startedAt: event.at,
          lastProgressAt: event.at,
        });
      }
    } else {
      const call = tools.calls.get(event.toolCallId);
      if (!call) return;
      if (event.phase === "progress") call.lastProgressAt = event.at;
      else tools.calls.delete(event.toolCallId);
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

    // Claim the generation synchronously before cleanup awaits. Later tool
    // boundaries cannot revive a terminal timeout.
    this.clearWatchdog(address);
    this.clearToolLifecycle(address, worker);
    const record = this.records.get(address);
    if (!record) return;
    this.workerUnsubscribers.get(address)?.();
    this.workerUnsubscribers.delete(address);
    this.workers.delete(address);
    this.active.delete(address);
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
    let cleanup = "";
    try { await bounded(worker.abort(), record.lifecycle.abortTimeoutMs, "LIFECYCLE_ABORT_TIMEOUT"); }
    catch (error) { cleanup = `; abort cleanup: ${errorMessage(error)}`; }
    try { await bounded(worker.dispose(), record.lifecycle.disposeTimeoutMs, "LIFECYCLE_DISPOSE_TIMEOUT"); }
    catch (error) { cleanup += `; dispose cleanup: ${errorMessage(error)}`; }
    if (cleanup) record.failure += cleanup;
    await this.persistRegistry();
    this.options.mainAdapter.notifyFailure(`${address}: ${record.failure}`);
    this.pump();
    this.publish();
  }

  private syncWorker(address: string, worker: WorkerTransport): void {
    const current = this.records.get(address);
    if (!current) return;
    try {
      const snapshot = worker.getSnapshot().record;
      current.sessionFile = worker.getSessionFile();
      current.effort = snapshot.effort;
      current.usage = snapshot.usage;
      current.activity = snapshot.activity.slice(-40);
      current.lastActivityAt = snapshot.lastActivityAt;
      current.currentActivity = snapshot.currentActivity;
      current.work = snapshot.work ? clone(snapshot.work) : current.work;
      current.updatedAt = nowIso();
    } catch {
      // The worker may emit while start is still constructing its session.
    }
  }

  private onWorkerEvent(address: string, worker: WorkerTransport, event: WorkerEvent): void {
    if (this.disposed || this.workers.get(address) !== worker) return;
    const record = this.records.get(address);
    if (!record) return;
    if (event.type === "tool_lifecycle") {
      this.onToolLifecycle(address, worker, event);
      return;
    }
    this.syncWorker(address, worker);
    if (event.type === "activity" || event.type === "work") this.touchWatchdog(address);
    if (event.type === "state" && event.state && record.state !== "failed" && record.state !== "stopped") {
      record.state = event.state;
    }
    if (event.type === "failure" && event.error) {
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      const shouldNotify = record.state !== "failed" || record.failure !== event.error;
      record.state = "failed";
      this.interruptRecordWork(record);
      record.failure = event.error;
      record.currentActivity = `Failed: ${event.error}`;
      record.activity.push({ at: nowIso(), kind: "error", summary: event.error });
      record.activity = record.activity.slice(-40);
      record.updatedAt = nowIso();
      this.active.delete(address);
      this.persistRegistry().then(() => this.pump(), () => this.pump());
      if (shouldNotify) this.options.mainAdapter.notifyFailure(`${address}: ${event.error}`);
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
        if (!this.disposed) swallow(this.persistRegistry());
      }, 25);
      timer.unref?.(); this.pendingWorkPersists.set(address, timer);
    }
    if (event.type === "state" || event.type === "settled") swallow(this.persistRegistry());
    this.publish();
    if (event.type === "settled") {
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      if (this.settling.has(address)) this.pendingSettlements.add(address);
      else swallow(this.onWorkerSettled(address, worker, event.completionText));
    }
  }

  private async routeToWorker(envelope: EmailEnvelope, worker: WorkerTransport): Promise<void> {
    const snapshot = worker.getSnapshot();
    if (snapshot.record.state === "stopped") return;
    if (snapshot.isStreaming) {
      if (envelope.priority === "high") {
        // Requests are marked delivered before steering so the worker's own
        // fetch_emails sees them immediately; replies commit their answer only
        // after steer acceptance so a rejection still releases the reservation.
        if (envelope.kind === "request") await this.mailStore.markDelivered([envelope.id]);
        const record = this.records.get(envelope.to);
        try {
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
    return {
      emails: this.selectBatch(all, this.toolResultByteLimit, MAIL_TOOL_BATCH_LINES),
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
        || left.rank[2].localeCompare(right.rank[2]))[0]!;
    this.pendingStarts.splice(ranked.index, 1);
    return ranked.address;
  }

  private async schedule(address: string): Promise<void> {
    if (this.disposed || this.scheduling.has(address) || this.active.has(address)) return;
    const worker = this.workers.get(address);
    const record = this.records.get(address);
    if (!worker || !record || ["stopped", "failed"].includes(record.state)) return;
    const pending = this.mailStore.queued(address);
    const queued = this.selectBatch(pending);
    if (queued.length === 0) {
      const oversized = pending[0];
      if (oversized) {
        const error = `Formatted email exceeds the ${this.options.config.maxBatchBytes}-byte delivery limit.`;
        await this.failEnvelope(oversized, error);
        this.options.mainAdapter.notifyFailure(`${oversized.id} could not be delivered to ${address}: ${error}`);
        this.scheduleMailMaintenance();
        swallow(this.schedule(address));
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
    try {
      if (requestIds.length > 0) await this.mailStore.markDelivered(requestIds);
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
      for (const email of queued) await this.failEnvelope(email, errorMessage(error));
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      this.active.delete(address);
      record.state = "failed";
      record.failure = errorMessage(error);
      record.updatedAt = nowIso();
      await this.persistRegistry();
      this.options.mainAdapter.notifyFailure(`${address} could not start: ${record.failure}`);
      this.pump();
    } finally {
      this.scheduling.delete(address);
      this.publish();
      if (!this.disposed && this.workers.get(address) !== worker && this.mailStore.queued(address).length > 0) {
        swallow(this.schedule(address));
      }
    }
  }

  private async resumeEnforcement(address: string): Promise<void> {
    if (this.disposed || this.active.has(address)) return;
    const worker = this.workers.get(address);
    const record = this.records.get(address);
    const outstanding = this.fetchUnanswered(address);
    if (!worker || !record || outstanding.length === 0 || ["stopped", "failed"].includes(record.state)) return;
    if (this.active.size >= this.options.config.maxConcurrent) {
      this.enqueueStart(address);
      return;
    }
    this.active.add(address);
    record.state = "running";
    record.enforcementAttempts += 1;
    try {
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
      record.state = "failed";
      record.failure = errorMessage(error);
      await this.persistRegistry();
      this.options.mainAdapter.notifyFailure(`${address} could not resume unanswered email: ${record.failure}`);
      this.pump();
    } finally {
      this.publish();
    }
  }

  private async sendCompletionReplies(address: string, requests: EmailEnvelope[], completionText: string): Promise<void> {
    const distinctSenders = new Set(requests.map((request) => request.from));
    const sharedBody = distinctSenders.size === 1
      ? completionText.trim()
      : `Automatic completion notice: ${address} finished a batch containing requests from multiple senders without sending a dedicated reply to this message. The combined final text was not forwarded to avoid cross-request disclosure. Send a follow-up for a dedicated result.`;
    const message = boundedCompletionMessage(sharedBody, this.options.config.maxMessageBytes);
    for (const request of requests) {
      try {
        await this.send(address, {
          to: request.from,
          subject: makeReplySubject(request.id, request.subject),
          message,
          priority: "low",
        });
      } catch (error) {
        const record = this.records.get(address);
        if (record) {
          const summary = truncateText(`Automatic completion email for ${request.id} failed: ${errorMessage(error)}`, 500);
          record.activity.push({ at: nowIso(), kind: "error", summary });
          record.activity = record.activity.slice(-40);
        }
      }
    }
  }

  private async onWorkerSettled(address: string, worker: WorkerTransport, completionText?: string): Promise<void> {
    if (this.disposed || this.settling.has(address) || this.workers.get(address) !== worker) return;
    this.settling.add(address);
    const record = this.records.get(address);
    try {
      if (!record || record.state === "stopped" || record.state === "failed") return;
      this.syncWorker(address, worker);
      this.interruptRecordWork(record);
      let outstanding = this.fetchUnanswered(address);
      if (outstanding.length > 0 && completionText?.trim()) {
        await this.sendCompletionReplies(address, outstanding, completionText);
        outstanding = this.fetchUnanswered(address);
      }
      if (outstanding.length > 0) {
        if (record.enforcementAttempts < this.options.config.responseReminderLimit) {
          record.enforcementAttempts += 1;
          record.state = "running";
          record.currentActivity = `Answering ${outstanding.length} required email${outstanding.length === 1 ? "" : "s"}`;
          await bounded(worker.prompt(enforcementPrompt(outstanding.length, record.enforcementAttempts > 1), { newBatch: false }), record.lifecycle.promptAcceptanceTimeoutMs, "LIFECYCLE_PROMPT_ACCEPTANCE_TIMEOUT");
          if (this.disposed || this.workers.get(address) !== worker) return;
          this.startWatchdog(address);
          await this.persistRegistry();
          return;
        }
        this.clearWatchdog(address);
        this.clearToolLifecycle(address, worker);
        record.state = "failed";
        record.failure = `Stopped with ${outstanding.length} unanswered email(s) after ${record.enforcementAttempts} reminder(s).`;
        this.active.delete(address);
        await this.persistRegistry();
        this.options.mainAdapter.notifyFailure(`${address}: ${record.failure}`);
        this.pump();
        return;
      }

      record.enforcementAttempts = 0;
      record.state = "idle";
      record.failure = undefined;
      record.currentActivity = "Idle";
      record.updatedAt = nowIso();
      this.active.delete(address);
      await this.persistRegistry();
      if (this.mailStore.queued(address).length > 0) swallow(this.schedule(address));
      this.pump();
    } catch (error) {
      if (this.disposed || this.workers.get(address) !== worker) return;
      if (error instanceof LifecycleTimeoutError) {
        this.startWatchdog(address);
        await this.expireWorker(address, this.watchdogs.get(address)!.generation, error.code);
        return;
      }
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      if (record) {
        record.state = "failed";
        record.failure = errorMessage(error);
        record.updatedAt = nowIso();
      }
      this.active.delete(address);
      await this.persistRegistry();
      this.options.mainAdapter.notifyFailure(`${address} settlement failed: ${errorMessage(error)}`);
      this.pump();
    } finally {
      this.settling.delete(address);
      this.publish();
      if (this.pendingSettlements.delete(address) && !this.disposed && this.workers.get(address) === worker) {
        swallow(this.onWorkerSettled(address, worker));
      }
    }
  }

  private pump(): void {
    while (this.active.size < this.options.config.maxConcurrent && this.pendingStarts.length > 0) {
      const address = this.takeNextPending();
      if (!address) break;
      const record = this.records.get(address);
      if (!record || ["stopped", "failed", "archived"].includes(record.state)) continue;
      if (this.fetchUnanswered(address).length > 0) swallow(this.resumeEnforcement(address));
      else swallow(this.schedule(address));
    }
  }

  async stop(addressInput: string): Promise<void> {
    const address = addressInput.trim().toLowerCase();
    await this.withAddressOperation(address, async () => {
      const worker = this.workers.get(address);
      const record = this.records.get(address);
      if (!record) throw new Error(`Unknown agent ${address}.`);
      if (record.state === "archived") throw new Error(`Agent ${address} is archived.`);
      let cleanupError: unknown;
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      if (worker) {
        this.syncWorker(address, worker);
        try {
          await bounded(worker.abort(), record.lifecycle.abortTimeoutMs, "LIFECYCLE_ABORT_TIMEOUT");
        } catch (error) {
          cleanupError = error;
        } finally {
          this.workerUnsubscribers.get(address)?.();
          this.workerUnsubscribers.delete(address);
          this.workers.delete(address);
          try {
            await bounded(worker.dispose(), record.lifecycle.disposeTimeoutMs, "LIFECYCLE_DISPOSE_TIMEOUT");
          } catch (error) {
            cleanupError ??= error;
          }
        }
      }
      this.assertActive();
      this.active.delete(address);
      record.state = "stopped";
      this.interruptRecordWork(record);
      if (cleanupError) record.failure = `Stop cleanup reported: ${errorMessage(cleanupError)}`;
      record.currentActivity = cleanupError ? `Stopped after abort error: ${errorMessage(cleanupError)}` : "Stopped by user";
      record.updatedAt = nowIso();
      await this.persistRegistry();
      this.pump();
      this.publish();
      if (cleanupError) throw new Error(`Agent was stopped, but cleanup reported: ${errorMessage(cleanupError)}`);
    });
  }

  async restart(addressInput: string): Promise<void> {
    const address = addressInput.trim().toLowerCase();
    await this.withAddressOperation(address, async () => {
      const record = this.records.get(address);
      if (!record) throw new Error(`Unknown agent ${address}.`);
      const parsed = parseSubagentAddress(address, this.catalog);
      if (!this.activationLeases.has(address)) {
        if (this.activeIdentityCount() >= this.options.config.maxAgents) {
          throw new Error(`Agent limit reached (${this.options.config.maxAgents}).`);
        }
        this.activationLeases.add(address);
      }
      const old = this.workers.get(address);
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, old);
      this.workerUnsubscribers.get(address)?.();
      this.workerUnsubscribers.delete(address);
      this.workers.delete(address);
      let cleanupError: unknown;
      if (old) {
        try { await bounded(old.dispose(), record.lifecycle.disposeTimeoutMs, "LIFECYCLE_DISPOSE_TIMEOUT"); } catch (error) { cleanupError = error; }
      }
      this.assertActive();
      this.active.delete(address);
      record.state = "paused";
      this.interruptRecordWork(record);
      delete record.failure;
      record.enforcementAttempts = 0;
      await this.createWorker(parsed, record, this.lifecycleGeneration);
      if (cleanupError) {
        const warning = `Previous worker cleanup reported during restart: ${errorMessage(cleanupError)}`;
        record.activity.push({ at: nowIso(), kind: "error", summary: warning });
        record.activity = record.activity.slice(-40);
        await this.persistRegistry();
        this.options.mainAdapter.notifyFailure(`${address}: ${warning}`);
      }
      if (this.fetchUnanswered(address).length > 0) await this.resumeEnforcement(address);
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
      if (request.deliveryState === "cancelled") {
        this.scheduleMailMaintenance();
        this.emitChange();
        this.publish();
        return request;
      }
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
      if (record.state === "archived") return;
      const worker = this.workers.get(address);
      if (record.state === "running" || record.state === "spawning" || worker?.getSnapshot().isStreaming) {
        throw new Error("Running agents must be stopped and settled before archival.");
      }
      const obligated = this.mailStore.list().some((email) =>
        (email.to === address && (email.deliveryState === "queued" || (email.deliveryState === "delivered" && email.requiresResponse && !email.answeredAt)))
        || (email.from === address && (email.deliveryState === "queued"
          || (email.deliveryState === "delivered" && email.requiresResponse && !email.answeredAt)
          || Boolean(email.replyReservedBy))),
      );
      if (obligated) throw new Error("Agent has queued mail or unanswered obligations and cannot be archived.");
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      this.workerUnsubscribers.get(address)?.();
      this.workerUnsubscribers.delete(address);
      this.workers.delete(address);
      let cleanupError: unknown;
      if (worker) {
        try { await bounded(worker.dispose(), record.lifecycle.disposeTimeoutMs, "LIFECYCLE_DISPOSE_TIMEOUT"); } catch (error) { cleanupError = error; }
      }
      this.assertActive();
      this.active.delete(address);
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
      if (cleanupError) throw new Error(`Agent was archived, but cleanup reported: ${errorMessage(cleanupError)}`);
    });
  }

  async clearFailure(addressInput: string): Promise<void> {
    const address = addressInput.trim().toLowerCase();
    await this.withAddressOperation(address, async () => {
      const record = this.records.get(address);
      if (!record) throw new Error(`Unknown agent ${address}.`);
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
    const parsed = existing ? undefined : parseSubagentAddress(shape.address, this.catalog);
    const address = existing?.address ?? parsed!.address;
    const name = existing?.name ?? parsed!.name;
    const record = this.records.get(address);
    if (record && effortOverride !== undefined) {
      throw new Error("An effort override can preview only a prospective unknown agent; omit effort for an existing identity.");
    }
    const profile = resolveAgentProfile(this.options.config, address, name);
    const tools = record?.tools ?? profile.tools;
    const mail = this.mailStore.list();
    return {
      address,
      exists: Boolean(record),
      wouldSpawn: !record,
      capacityAvailable: (!record || this.routableRecords.has(address))
        && (this.activationLeases.has(address) || this.activeIdentityCount() < this.options.config.maxAgents),
      modelId: record?.modelId ?? parsed!.model.id,
      provider: record?.provider ?? parsed!.model.provider,
      effort: record?.effort ?? effortOverride ?? profile.effort,
      role: name,
      tools: [...tools],
      ...(record?.instructions ?? profile.instructions ? { instructions: record?.instructions ?? profile.instructions } : {}),
      writable: tools.some((tool) => ["bash", "edit", "write"].includes(tool)),
      canSpawn: record?.canSpawn ?? profile.canSpawn,
      state: record?.state ?? "new",
      ...(record?.currentActivity ? { currentActivity: record.currentActivity } : {}),
      queued: this.mailStore.queued(address).length,
      unanswered: mail.filter((email) =>
        email.to === address && email.deliveryState === "delivered" && email.requiresResponse
          && !email.answeredAt && !email.replyReservedBy).length,
      pendingReplies: mail.filter((email) => email.to === address && Boolean(email.replyReservedBy) && !email.answeredAt).length,
      usage: clone(record?.usage ?? emptyUsage()),
      ...(record?.failure ? { failure: record.failure } : {}),
      providerReady: this.workers.has(address) ? "available" : "unknown",
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
      }, timeoutMs);
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
      const { work, ...withoutWork } = source;
      return { ...clone(withoutWork), ...(work ? { work: lightweightWork(work) } : {}) } as AgentRecord;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const unanswered = this.mailStore.list().filter((email) =>
      email.requiresResponse && !email.answeredAt && !email.replyReservedBy && email.deliveryState === "delivered").length;
    return { mainAddress: this.mainAddress, agents, unanswered, queuedMail: this.mailStore.countQueued() };
  }

  private scheduleMailMaintenance(): void {
    if (this.disposed) return;
    const operation = this.mailStore.maintainIfNeeded(undefined, this.options.config.maxRetainedEmails).catch((error) => {
      this.options.mainAdapter.notifyFailure(`Mail journal maintenance failed: ${errorMessage(error)}`);
    });
    // Track the mutation itself, not a wrapper whose settlement runs the
    // removal finalizer. Shutdown may snapshot this set while it settles;
    // the barrier must never wait on its own bookkeeping promise.
    this.inFlightOperations.add(operation);
    this.operationLabels.set(operation, "mail-maintenance");
    void operation.then(
      () => { this.inFlightOperations.delete(operation); },
      () => { this.inFlightOperations.delete(operation); },
    );
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
    const allWorkers = new Set<WorkerTransport>([...committed.values(), ...this.provisionalWorkers]);
    for (const [address, worker] of committed) {
      this.clearWatchdog(address);
      this.clearToolLifecycle(address, worker);
      const record = this.records.get(address);
      if (record && !["stopped", "failed", "archived"].includes(record.state)) {
        this.syncWorker(address, worker);
        record.state = "paused";
        this.interruptRecordWork(record);
        record.updatedAt = nowIso();
      }
      this.workerUnsubscribers.get(address)?.();
    }
    this.workers.clear();
    this.workerUnsubscribers.clear();
    this.toolLifecycles.clear();
    this.active.clear();
    const results = await Promise.allSettled([...allWorkers].map((worker) => {
      const address = [...committed].find(([, candidate]) => candidate === worker)?.[0];
      const timeout = Math.min(maximumTimeoutMs, (address ? this.records.get(address)?.lifecycle.disposeTimeoutMs : undefined)
        ?? this.options.config.lifecycle.disposeTimeoutMs);
      return bounded(worker.dispose(), timeout, "LIFECYCLE_DISPOSE_TIMEOUT");
    }));
    for (const worker of allWorkers) this.provisionalWorkers.delete(worker);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
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
    let quiescenceKnown = true;
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
        quiescenceKnown = false;
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
          quiescenceKnown = false;
        }
      }
    };

    // Do not short-circuit: every phase is attempted or explicitly marked
    // non-quiescent under the one global deadline.
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
    await runPhase("LIFECYCLE_BROKER_SHUTDOWN_PERSIST_TIMEOUT", () => this.persistRegistry(true));
    await runPhase("LIFECYCLE_BROKER_SHUTDOWN_FLUSH_TIMEOUT", () =>
      Promise.all([this.mailStore.flush(), this.registryStore.flush()]));

    // Namespace ownership is a safety lease, not merely cleanup. A timed-out
    // mutator may still write later, so retain ownership until process death.
    if (quiescenceKnown) {
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
