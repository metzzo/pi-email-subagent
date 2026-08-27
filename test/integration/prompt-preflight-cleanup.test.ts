import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { SdkWorker } from "../../src/sdk-worker.ts";
import type { AgentRecord, WorkerStartConfig } from "../../src/types.ts";
import { emptyWorkState } from "../../src/work-ledger.ts";
import { eventually, FakeMainAdapter, fakeModel } from "../helpers/fakes.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface RunCounters {
  provider: number;
  tools: number;
  mail: number;
}

class PinnedPreflightSession {
  isIdle = true;
  isStreaming = false;
  disposed = 0;
  promptCount = 0;
  readonly entered = deferred();
  readonly release = deferred();
  private readonly run = deferred();

  constructor(
    private readonly oldGeneration: boolean,
    readonly counters: RunCounters,
  ) {}

  async prompt(_message: string, options: { preflightResult(success: boolean): void }): Promise<void> {
    const promptNumber = this.promptCount++;
    if (this.oldGeneration && promptNumber === 0) {
      // A pinned-accurate Pi 0.84.2 handled-input preflight: accepted without
      // entering _runAgentPrompt. This creates the worker without a provider run.
      options.preflightResult(true);
      return;
    }
    if (this.oldGeneration) {
      this.entered.resolve();
      await this.release.promise;
    }
    // Pi 0.84.2 calls preflightResult(true) synchronously immediately before
    // _runAgentPrompt. If the callback throws, the following old run is vetoed.
    options.preflightResult(true);
    this.isIdle = false;
    this.isStreaming = true;
    this.counters.provider += 1;
    await this.run.promise;
    this.isStreaming = false;
    this.isIdle = true;
  }

  async abort(): Promise<void> {
    this.isStreaming = false;
    this.isIdle = true;
    this.run.resolve();
  }

  dispose(): void { this.disposed += 1; }
}

function pinnedWorker(session: PinnedPreflightSession): SdkWorker {
  const worker = new SdkWorker({} as never);
  worker.start = async (config: WorkerStartConfig): Promise<void> => {
    const record = structuredClone(config.record) as AgentRecord;
    record.state = "idle";
    record.work ??= emptyWorkState();
    const internal = worker as unknown as {
      record: AgentRecord;
      session: PinnedPreflightSession;
      sessionManager: { appendCustomEntry(type: string, data: unknown): void };
      cwd: string;
    };
    internal.record = record;
    internal.session = session;
    internal.sessionManager = { appendCustomEntry: () => undefined };
    internal.cwd = config.cwd;
  };
  return worker;
}

function brokerAt(root: string, sessions: PinnedPreflightSession[], counters: RunCounters[]) {
  return new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config: structuredClone(DEFAULT_CONFIG),
    models: [fakeModel("gpt-5.4")],
    mainAdapter: new FakeMainAdapter(),
    workerFactory: () => {
      const generationCounters = { provider: 0, tools: 0, mail: 0 };
      const session = new PinnedPreflightSession(sessions.length === 0, generationCounters);
      counters.push(generationCounters);
      sessions.push(session);
      return pinnedWorker(session);
    },
    projectTrusted: true,
  });
}

const ADDRESS = "worker.prompt-preflight@gpt-5.4.com";

async function seedHandledWorker(broker: AgentBroker): Promise<void> {
  await broker.send(broker.mainAddress, {
    to: ADDRESS,
    subject: "Preserved obligation",
    message: "Remain unanswered until the next safe generation.",
    priority: "low",
  });
}

describe("Pi prompt preflight cleanup ownership", () => {
  it("manual stop joins and vetoes late old-generation preflight before G+1 runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-preflight-stop-"));
    const sessions: PinnedPreflightSession[] = [];
    const counters: RunCounters[] = [];
    const broker = brokerAt(root, sessions, counters);
    await broker.init();
    try {
      await seedHandledWorker(broker);
      const oldWorker = (broker as unknown as { workers: Map<string, SdkWorker> }).workers.get(ADDRESS)!;
      const oldSession = sessions[0]!;
      const promptOutcome = oldWorker.prompt("delayed Pi preflight").then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      await oldSession.entered.promise;

      let stopSettled = false;
      const stopping = broker.stop(ADDRESS).then(() => { stopSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(stopSettled, false, "stop cannot release the exact worker during prompt preflight");
      assert.equal(oldSession.disposed, 0);

      oldSession.release.resolve();
      await stopping;
      assert.equal(await promptOutcome, "rejected");
      assert.deepEqual(counters[0], { provider: 0, tools: 0, mail: 0 });
      assert.equal(oldSession.disposed, 1);

      await broker.restart(ADDRESS);
      assert.equal(sessions.length, 2);
      assert.deepEqual(counters[1], { provider: 1, tools: 0, mail: 0 }, "only G+1 reaches the provider");
    } finally {
      for (const session of sessions) session.release.resolve();
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("broker shutdown joins and vetoes late preflight before a restored G+1 runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-preflight-shutdown-"));
    const oldSessions: PinnedPreflightSession[] = [];
    const oldCounters: RunCounters[] = [];
    const first = brokerAt(root, oldSessions, oldCounters);
    await first.init();
    await seedHandledWorker(first);
    const oldWorker = (first as unknown as { workers: Map<string, SdkWorker> }).workers.get(ADDRESS)!;
    const oldSession = oldSessions[0]!;
    const promptOutcome = oldWorker.prompt("delayed shutdown preflight").then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await oldSession.entered.promise;

    let shutdownSettled = false;
    const shuttingDown = first.shutdown().then(() => { shutdownSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(shutdownSettled, false, "shutdown retains namespace ownership through prompt preflight");
    assert.equal(oldSession.disposed, 0);
    oldSession.release.resolve();
    await shuttingDown;
    assert.equal(await promptOutcome, "rejected");
    assert.deepEqual(oldCounters[0], { provider: 0, tools: 0, mail: 0 });

    const nextSessions: PinnedPreflightSession[] = [oldSession];
    const nextCounters: RunCounters[] = [oldCounters[0]!];
    const next = brokerAt(root, nextSessions, nextCounters);
    await next.init();
    try {
      assert.equal(nextSessions.length, 2);
      await eventually(() => {
        assert.deepEqual(nextCounters[1], { provider: 1, tools: 0, mail: 0 }, "restored G+1 alone reaches the provider");
      });
    } finally {
      for (const session of nextSessions) session.release.resolve();
      await next.shutdown();
    }
  });
});
