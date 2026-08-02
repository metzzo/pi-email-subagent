import type { Model } from "@earendil-works/pi-ai";
import type {
  ActivityItem,
  AgentRecord,
  BrokerSnapshot,
  EmailEnvelope,
  MainAdapter,
  MainDelivery,
  SendEmailInput,
  SendEmailResult,
  WorkerEvent,
  WorkerSnapshot,
  WorkerStartConfig,
  WorkerTransport,
} from "../../src/types.ts";

export function fakeModel(id = "gpt-5.4", provider = "openai-codex"): Model<any> {
  return {
    id,
    name: id,
    provider,
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  } as Model<any>;
}

export class FakeMainAdapter implements MainAdapter {
  address: string;
  aliases: Set<string>;
  deliveries: MainDelivery[] = [];
  failures: string[] = [];
  snapshots: BrokerSnapshot[] = [];

  constructor(address = "main@gpt-5.4.com") {
    this.address = address;
    this.aliases = new Set([address]);
  }

  getAddress(): string { return this.address; }
  getAliases(): ReadonlySet<string> { return this.aliases; }
  async deliver(delivery: MainDelivery): Promise<void> { this.deliveries.push(structuredClone(delivery)); }
  notifyFailure(message: string): void { this.failures.push(message); }
  updateState(snapshot: BrokerSnapshot): void { this.snapshots.push(structuredClone(snapshot)); }
}

function clonedRecord(record: AgentRecord): AgentRecord {
  return structuredClone(record);
}

export class FakeWorker implements WorkerTransport {
  config?: WorkerStartConfig;
  record?: AgentRecord;
  prompts: string[] = [];
  steers: string[] = [];
  followUps: string[] = [];
  aborted = false;
  disposed = false;
  streaming = false;
  idle = true;
  listeners = new Set<(event: WorkerEvent) => void>();

  async start(config: WorkerStartConfig): Promise<void> {
    this.config = config;
    this.record = clonedRecord(config.record);
    this.record.state = "idle";
  }

  async prompt(message: string): Promise<void> {
    if (!this.record) throw new Error("not started");
    if (!this.idle) throw new Error("not idle");
    this.prompts.push(message);
    this.streaming = true;
    this.idle = false;
    this.record.state = "running";
    this.emit({ type: "state", state: "running" });
  }

  async steer(message: string): Promise<void> {
    if (!this.streaming) throw new Error("not streaming");
    this.steers.push(message);
  }

  async followUp(message: string): Promise<void> { this.followUps.push(message); }

  async abort(): Promise<void> {
    this.aborted = true;
    this.streaming = false;
    this.idle = true;
    if (this.record) this.record.state = "stopped";
  }

  async dispose(): Promise<void> { this.disposed = true; this.listeners.clear(); }

  setEffort(level: AgentRecord["effort"]): void {
    if (!this.idle) throw new Error("not idle");
    if (this.record) this.record.effort = level;
  }

  getSnapshot(): WorkerSnapshot {
    if (!this.record) throw new Error("not started");
    return { record: clonedRecord(this.record), isIdle: this.idle, isStreaming: this.streaming };
  }

  getSessionFile(): string | undefined { return this.record?.sessionFile; }

  subscribe(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: WorkerEvent): void { for (const listener of this.listeners) listener(event); }

  settle(completionText?: string): void {
    if (!this.record) throw new Error("not started");
    this.streaming = false;
    this.idle = true;
    this.record.state = "idle";
    const activity: ActivityItem = { at: new Date().toISOString(), kind: "status", summary: "settled" };
    this.record.activity.push(activity);
    this.emit({ type: "settled", ...(completionText ? { completionText } : {}) });
  }

  fail(message: string): void { this.emit({ type: "failure", error: message }); }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.config) throw new Error("not started");
    return this.config.sendEmail(input);
  }

  fetch(): EmailEnvelope[] {
    if (!this.config) throw new Error("not started");
    return this.config.fetchEmails().emails;
  }
}

export function createWorkerFactory(target: FakeWorker[]): () => FakeWorker {
  return () => {
    const worker = new FakeWorker();
    target.push(worker);
    return worker;
  };
}

export async function eventually(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("eventually timed out");
}
