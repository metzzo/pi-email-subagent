import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export type EmailPriority = "high" | "low";
export type EmailKind = "request" | "reply";
export type DeliveryState = "queued" | "delivered" | "failed" | "cancelled";
export type AgentStatus = "queued" | "spawning" | "running" | "idle" | "parked" | "failed" | "stopped" | "paused" | "archived";

export interface ModelBinding {
  provider: string;
  modelId: string;
}

export interface EmailEnvelope {
  id: string;
  from: string;
  to: string;
  subject: string;
  message: string;
  priority: EmailPriority;
  kind: EmailKind;
  inReplyTo?: string;
  requiresResponse: boolean;
  createdAt: string;
  deliveredAt?: string;
  answeredAt?: string;
  answeredBy?: string;
  replyReservedAt?: string;
  replyReservedBy?: string;
  deliveryState: DeliveryState;
  error?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancellationReason?: string;
  /** Durable spawn intent, present only on the first accepted request for a new identity. */
  lifecycleIntent?: LifecyclePolicy;
  /** Durable initial thinking-level intent for crash-safe identity creation. */
  effortIntent?: ThinkingLevel;
  /** Durable provider/model selected when accepting mail for a new identity. */
  modelBindingIntent?: ModelBinding;
}

export interface ParsedAddress {
  address: string;
  name: string;
  taskSlug: string;
  modelId: string;
  model: Model<any>;
}

export interface LifecyclePolicy {
  spawnTimeoutMs: number;
  promptAcceptanceTimeoutMs: number;
  runTimeoutMs: number;
  idleTimeoutMs: number;
  abortTimeoutMs: number;
  disposeTimeoutMs: number;
  brokerShutdownTimeoutMs: number;
}

export type LifecycleOverride = Partial<LifecyclePolicy>;

export interface RoleConfig {
  effort?: ThinkingLevel;
  tools?: string[];
  instructions?: string;
  canSpawn?: boolean;
  lifecycle?: LifecycleOverride;
}

export interface AddressConfig extends RoleConfig {}

export interface SubagentConfig {
  defaultEffort: ThinkingLevel;
  modelPolicy: string;
  maxAgents: number;
  maxConcurrent: number;
  maxMessageBytes: number;
  maxSubjectBytes: number;
  maxMailsPerMinute: number;
  maxMailsPerSenderPerMinute: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  maxBatchMessages: number;
  maxBatchBytes: number;
  maxRetainedEmails: number;
  responseReminderLimit: number;
  lifecycle: LifecyclePolicy;
  lifecycleMaxima: LifecyclePolicy;
  roles: Record<string, RoleConfig>;
  addresses: Record<string, AddressConfig>;
}

export interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface ActivityItem {
  at: string;
  kind: "status" | "tool" | "text" | "error";
  summary: string;
}

export type WorkKind = "edit" | "write" | "shell" | "custom";
export type WorkStatus = "running" | "succeeded" | "failed" | "interrupted" | "unknown";
export type WorkAttribution = "explicit" | "unverified";
export type WorkObservedResult = "success" | "error";
export type WorkUnknownReason = "missing-start" | "mismatched-tool" | "unsafe-path" | "orphan-result";

export interface WorkItem {
  toolCallId: string;
  batchId: number;
  toolName: string;
  kind: WorkKind;
  attribution: WorkAttribution;
  status: WorkStatus;
  startedAt: string;
  endedAt?: string;
  /** Pi's terminal result flag; this does not confirm which effects occurred. */
  observedResult?: WorkObservedResult;
  /** Fixed structural reason for a terminal unknown-effect item. */
  reasonCode?: WorkUnknownReason;
  durationMs?: number;
  path?: string;
  displayPath?: string;
  editBlocks?: number;
  commandPreview?: string;
  error?: string;
  bytesWritten?: number;
  linesWritten?: number;
  linesAdded?: number;
  linesRemoved?: number;
  firstChangedLine?: number;
  patchPreview?: string;
  patchTruncated?: boolean;
  patchSource?: "event" | "session";
  /** Snapshot-only hint when the heavy preview was omitted. */
  patchAvailable?: boolean;
}

export interface WorkCounters { reads: number; searches: number; listings: number }
export interface AgentWorkState {
  nextBatchId: number;
  currentBatchId?: number;
  batchStartedAt?: string;
  batchEndedAt?: string;
  active: WorkItem[];
  recent: WorkItem[];
  inspection: WorkCounters;
  /** The bounded recovery slice omitted structural effect evidence. */
  effectEvidenceUnavailable?: boolean;
  recoveryError?: string;
}

export type CleanupPhaseState = "pending" | "succeeded" | "failed" | "timed-out";

export interface CleanupToolRef {
  toolCallId: string;
  toolName: string;
}

/** Persisted fail-closed summary; an in-memory cleanup Promise is never persisted. */
export interface WorkerCapabilityEpoch {
  generation: number;
  phase: "spawning" | "activated" | "session-settled";
  tools: string[];
  mutationCapable: boolean;
  runSlotHeld: boolean;
}

export interface CleanupDiagnostic {
  state: "pending" | "unknown";
  reasonCode: string;
  workerGeneration: number;
  startedAt: string;
  updatedAt: string;
  abort: CleanupPhaseState;
  dispose: CleanupPhaseState;
  /** Compatibility field: Pi session/tool settlement is not yet known. */
  quiescence: "unknown";
  /** Capability of the exact worker generation, independent of later config changes. */
  mutationCapableAtStart: boolean;
  /** Whether this cleanup generation inherited one concrete run-slot lease. */
  heldRunSlot: boolean;
  activeTools: CleanupToolRef[];
  detail?: string;
}

export interface AgentRecord {
  address: string;
  name: string;
  taskSlug: string;
  provider: string;
  modelId: string;
  effort: ThinkingLevel;
  /** Current configured intent. */
  tools: string[];
  /** Current live activation, exposed only in derived snapshots while the exact worker exists. */
  activeTools?: string[];
  /** Durable capability evidence for one exact worker generation. */
  workerEpoch?: WorkerCapabilityEpoch;
  canSpawn: boolean;
  instructions?: string;
  state: AgentStatus;
  sessionFile?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  currentActivity?: string;
  failure?: string;
  cleanup?: CleanupDiagnostic;
  enforcementAttempts: number;
  lifecycle: LifecyclePolicy;
  usage: UsageSnapshot;
  activity: ActivityItem[];
  /** Bounded derived cache; session JSONL remains durable truth for edit/write results. */
  work?: AgentWorkState;
}

export interface BrokerRegistry {
  version: 1;
  mainAddress: string;
  mainAliases: string[];
  agents: AgentRecord[];
  updatedAt: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  message: string;
  priority: EmailPriority;
  /** Initial effort override, accepted only when this send creates an unknown identity. */
  effort?: ThinkingLevel;
  lifecycle?: LifecycleOverride;
}

export type RecipientDisposition = "main" | "spawned" | "reused" | "restored" | "stopped" | "failed";

export interface SendEmailResult {
  envelope: EmailEnvelope;
  spawned: boolean;
  recipientModel?: string;
  /** Exact provider selected for or preserved by the recipient identity. */
  recipientProvider?: string;
  recipientEffort?: ThinkingLevel;
  recipientRole?: string;
  recipientTools?: string[];
  recipientState?: AgentStatus;
  recipientLifecycle?: LifecyclePolicy;
  recipientCleanup?: CleanupDiagnostic;
  recipientDisposition: RecipientDisposition;
  expectedReplySubject?: string;
  correlationId: string;
  answeredEmailId?: string;
}

export interface AgentCapacitySnapshot {
  identitiesUsed: number;
  identitiesLimit: number;
  runSlotsUsed: number;
  runSlotsLimit: number;
}

export interface BoundedRequestIds {
  count: number;
  requestIds: string[];
  omitted: number;
}

export interface AgentArchiveBlockers {
  active: boolean;
  cleanupQuarantine: boolean;
  queued: BoundedRequestIds;
  incomingUnanswered: BoundedRequestIds;
  outgoingUnanswered: BoundedRequestIds;
  pendingReplies: BoundedRequestIds;
}

export interface AgentInspection {
  address: string;
  exists: boolean;
  wouldSpawn: boolean;
  capacityAvailable: boolean;
  capacity: AgentCapacitySnapshot;
  holdsActivationLease: boolean;
  modelId: string;
  provider: string;
  effort: ThinkingLevel;
  role: string;
  /** Current configured intent. */
  tools: string[];
  /** Exact Pi activation, present only while this identity has a live worker. */
  activeTools?: string[];
  instructions?: string;
  writable: boolean;
  canSpawn: boolean;
  state: AgentStatus | "new";
  currentActivity?: string;
  queued: number;
  unanswered: number;
  outgoingUnanswered: number;
  pendingReplies: number;
  archiveEligible: boolean;
  archiveBlockers: AgentArchiveBlockers;
  usage: UsageSnapshot;
  failure?: string;
  cleanup?: CleanupDiagnostic;
  providerReady: "available" | "unavailable" | "unknown";
  lifecycle: LifecyclePolicy;
}

export type ReplyWaitState = "answered" | "failed" | "cancelled" | "stopped" | "archived" | "paused" | "pending";

export interface ReplyWaitItem {
  requestId: string;
  state: ReplyWaitState;
  request?: EmailEnvelope;
  reply?: EmailEnvelope;
  error?: string;
}

export interface WaitForRepliesResult {
  complete: boolean;
  timedOut: boolean;
  items: ReplyWaitItem[];
}

export interface WorkerStatusEvent {
  type: "state" | "activity" | "work" | "settled" | "failure";
  state?: AgentStatus;
  activity?: ActivityItem;
  workItem?: WorkItem;
  error?: string;
}

/** Ephemeral, content-free tool execution boundaries for the broker watchdog. */
export interface WorkerToolLifecycleEvent {
  type: "tool_lifecycle";
  phase: "start" | "end";
  toolCallId: string;
  toolName: string;
}

/** Ephemeral model pulses and finite Pi retry boundaries; never persisted or published. */
export interface WorkerRunLivenessEvent {
  type: "run_liveness";
  phase: "model_start" | "model_progress" | "model_end" | "retry_start" | "retry_end";
  /** Present only for retry_start and derived from Pi's finite retry schedule. */
  delayMs?: number;
}

export type WorkerEvent = WorkerStatusEvent | WorkerToolLifecycleEvent | WorkerRunLivenessEvent;

export interface WorkerSnapshot {
  record: AgentRecord;
  /** Exact names returned by the live Pi session. */
  activeTools: string[];
  isIdle: boolean;
  isStreaming: boolean;
}

export interface WorkerCleanupToolReport extends CleanupToolRef {
  quiescence: "verified" | "unknown";
  detailCode?: string;
}

export interface WorkerCleanupReport {
  sessionDisposed: boolean;
  /** Whether the Pi AgentSession reached its idle boundary; never an OS descendant claim. */
  sessionIdle: boolean;
  tools: WorkerCleanupToolReport[];
  /** Compatibility field meaning only Pi session/tool settlement. */
  quiescence: "verified" | "unknown";
  source: string;
  abort: CleanupPhaseState;
  dispose: CleanupPhaseState;
  detail?: string;
}

export interface WorkerStartConfig {
  record: AgentRecord;
  model: Model<any>;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  projectTrusted: boolean;
  systemPrompt: string;
  sendEmail: (input: SendEmailInput, signal?: AbortSignal) => Promise<SendEmailResult>;
  fetchEmails: () => { emails: EmailEnvelope[]; total: number };
}

export interface WorkerTransport {
  start(config: WorkerStartConfig): Promise<void>;
  prompt(message: string, options?: { newBatch?: boolean }): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  cleanup(): Promise<WorkerCleanupReport>;
  setEffort(level: ThinkingLevel): void;
  getSnapshot(): WorkerSnapshot;
  getSessionFile(): string | undefined;
  subscribe(listener: (event: WorkerEvent) => void): () => void;
}

export interface MainDelivery {
  envelope: EmailEnvelope;
  formatted: string;
  triggerTurn?: boolean;
}

export interface MainAdapter {
  getAddress(): string;
  getAliases(): ReadonlySet<string>;
  isIdle(): boolean;
  deliver(delivery: MainDelivery): Promise<void>;
  notifyFailure(message: string): void;
  updateState(snapshot: BrokerSnapshot): void;
}

export interface BrokerSnapshot {
  mainAddress: string;
  agents: AgentRecord[];
  unanswered: number;
  queuedMail: number;
  /** Current derived view; never persisted in the registry. */
  capacity: AgentCapacitySnapshot;
}

export interface BrokerOptions {
  cwd: string;
  agentDir: string;
  namespaceDir: string;
  config: SubagentConfig;
  models: Model<any>[];
  preferredProvider?: string;
  mainAdapter: MainAdapter;
  /** Prepares the exact new-identity runtime request object before email.created. */
  workerPreflight?: (model: Model<any>) => unknown | Promise<unknown>;
  /** Must consume the exact preparation returned above when one is supplied. */
  workerFactory: (model: Model<any>, preparation?: unknown) => WorkerTransport | Promise<WorkerTransport>;
  projectTrusted: boolean;
}
