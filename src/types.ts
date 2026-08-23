import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export type EmailPriority = "high" | "low";
export type EmailKind = "request" | "reply";
export type DeliveryState = "queued" | "delivered" | "failed" | "cancelled";
export type AgentStatus = "queued" | "spawning" | "running" | "idle" | "failed" | "stopped" | "paused" | "archived";

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
export type WorkStatus = "running" | "succeeded" | "failed" | "interrupted";
export type WorkAttribution = "explicit" | "unverified";

export interface WorkItem {
  toolCallId: string;
  batchId: number;
  toolName: string;
  kind: WorkKind;
  attribution: WorkAttribution;
  status: WorkStatus;
  startedAt: string;
  endedAt?: string;
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
  recoveryError?: string;
}

export type CleanupPhaseState = "pending" | "succeeded" | "failed" | "timed-out";

export interface CleanupToolRef {
  toolCallId: string;
  toolName: string;
}

/** Persisted fail-closed summary; an in-memory cleanup Promise is never persisted. */
export interface CleanupDiagnostic {
  state: "pending" | "unknown";
  reasonCode: string;
  workerGeneration: number;
  startedAt: string;
  updatedAt: string;
  abort: CleanupPhaseState;
  dispose: CleanupPhaseState;
  quiescence: "unknown";
  heldCapacity: true;
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
  tools: string[];
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

export type RecipientDisposition = "main" | "spawned" | "reused" | "restored" | "stopped";

export interface SendEmailResult {
  envelope: EmailEnvelope;
  spawned: boolean;
  recipientModel?: string;
  recipientEffort?: ThinkingLevel;
  recipientRole?: string;
  recipientTools?: string[];
  recipientState?: AgentStatus;
  recipientLifecycle?: LifecyclePolicy;
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
  tools: string[];
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
  providerReady: "available" | "unknown";
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
  /** Visible final assistant text for mechanical completion-email fallback. */
  completionText?: string;
  error?: string;
}

/** Ephemeral, content-free tool execution liveness for the broker watchdog. */
export interface WorkerToolLifecycleEvent {
  type: "tool_lifecycle";
  phase: "start" | "progress" | "end";
  toolCallId: string;
  toolName: string;
  at: string;
}

export type WorkerEvent = WorkerStatusEvent | WorkerToolLifecycleEvent;

export interface WorkerSnapshot {
  record: AgentRecord;
  isIdle: boolean;
  isStreaming: boolean;
}

export interface WorkerCleanupToolReport extends CleanupToolRef {
  quiescence: "verified" | "not-applicable" | "unknown";
  detailCode?: string;
}

export interface WorkerCleanupReport {
  sessionDisposed: boolean;
  providerQuiescent: boolean;
  tools: WorkerCleanupToolReport[];
  quiescence: "verified" | "unknown";
  source: string;
  abort: CleanupPhaseState;
  dispose: CleanupPhaseState;
  detail?: string;
}

export interface WorkerCleanupOptions {
  abortTimeoutMs: number;
}

export interface WorkerStartConfig {
  record: AgentRecord;
  model: Model<any>;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  projectTrusted: boolean;
  systemPrompt: string;
  sendEmail: (input: SendEmailInput) => Promise<SendEmailResult>;
  fetchEmails: () => { emails: EmailEnvelope[]; total: number };
}

export interface WorkerTransport {
  start(config: WorkerStartConfig): Promise<void>;
  prompt(message: string, options?: { newBatch?: boolean }): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  cleanup(options: WorkerCleanupOptions): Promise<WorkerCleanupReport>;
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
  workerFactory: (model: Model<any>) => WorkerTransport | Promise<WorkerTransport>;
  projectTrusted: boolean;
}
