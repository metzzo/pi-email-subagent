import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export type EmailPriority = "high" | "low";
export type EmailKind = "request" | "reply";
export type DeliveryState = "queued" | "delivered" | "failed";
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
}

export interface ParsedAddress {
  address: string;
  name: string;
  taskSlug: string;
  modelId: string;
  model: Model<any>;
}

export interface RoleConfig {
  effort?: ThinkingLevel;
  tools?: string[];
  instructions?: string;
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
  responseReminderLimit: number;
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

export interface AgentRecord {
  address: string;
  name: string;
  taskSlug: string;
  provider: string;
  modelId: string;
  effort: ThinkingLevel;
  tools: string[];
  instructions?: string;
  state: AgentStatus;
  sessionFile?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  currentActivity?: string;
  failure?: string;
  enforcementAttempts: number;
  usage: UsageSnapshot;
  activity: ActivityItem[];
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
  recipientDisposition: RecipientDisposition;
  expectedReplySubject?: string;
  correlationId: string;
  answeredEmailId?: string;
}

export interface AgentInspection {
  address: string;
  exists: boolean;
  wouldSpawn: boolean;
  capacityAvailable: boolean;
  modelId: string;
  provider: string;
  effort: ThinkingLevel;
  role: string;
  tools: string[];
  instructions?: string;
  writable: boolean;
  state: AgentStatus | "new";
  currentActivity?: string;
  queued: number;
  unanswered: number;
  pendingReplies: number;
  usage: UsageSnapshot;
  failure?: string;
  providerReady: "available" | "unknown";
}

export type ReplyWaitState = "answered" | "failed" | "stopped" | "archived" | "paused" | "pending";

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

export interface WorkerEvent {
  type: "state" | "activity" | "settled" | "failure";
  state?: AgentStatus;
  activity?: ActivityItem;
  error?: string;
}

export interface WorkerSnapshot {
  record: AgentRecord;
  isIdle: boolean;
  isStreaming: boolean;
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
  fetchEmails: () => EmailEnvelope[];
}

export interface WorkerTransport {
  start(config: WorkerStartConfig): Promise<void>;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
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
}

export interface BrokerOptions {
  cwd: string;
  agentDir: string;
  namespaceDir: string;
  config: SubagentConfig;
  models: Model<any>[];
  mainAdapter: MainAdapter;
  workerFactory: (model: Model<any>) => WorkerTransport | Promise<WorkerTransport>;
  projectTrusted: boolean;
}
