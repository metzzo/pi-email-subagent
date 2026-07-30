import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { MailStore } from "../../src/mail-store.ts";
import type { LifecyclePolicy, SubagentConfig } from "../../src/types.ts";
import { eventually, FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

function policy(overrides: Partial<LifecyclePolicy> = {}): LifecyclePolicy {
  return { ...DEFAULT_CONFIG.lifecycle, ...overrides };
}

async function brokerWith(
  root: string,
  workerFactory: () => FakeWorker | Promise<FakeWorker>,
  configOverrides: Partial<SubagentConfig> = {},
) {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config, configOverrides);
  const broker = new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config,
    models: [fakeModel("gpt-5.4")],
    mainAdapter: new FakeMainAdapter(),
    workerFactory,
    projectTrusted: true,
  });
  await broker.init();
  return broker;
}

describe("initial delegation lifecycle", () => {
  it("persists and discloses the resolved initial override and rejects later mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-policy-"));
    const lifecycle = policy({ runTimeoutMs: 2_000, idleTimeoutMs: 1_500 });
    const { brokerShutdownTimeoutMs: _globalOnly, ...delegatedLifecycle } = lifecycle;
    const broker = await brokerWith(root, () => new FakeWorker());
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.policy@gpt-5.4.com",
        subject: "Policy",
        message: "Use the accepted finite policy.",
        priority: "low",
        lifecycle: delegatedLifecycle,
      });
      assert.deepEqual(sent.recipientLifecycle, lifecycle);
      assert.deepEqual(sent.envelope.lifecycleIntent, lifecycle);
      assert.deepEqual(broker.inspectAgent(sent.envelope.to).lifecycle, lifecycle);
      assert.deepEqual(broker.getSnapshot().agents[0]?.lifecycle, lifecycle);
      await assert.rejects(broker.send(broker.mainAddress, {
        to: sent.envelope.to,
        subject: "Mutate",
        message: "Do not silently mutate.",
        priority: "low",
        lifecycle: { runTimeoutMs: 3_000 },
      }), /only on the first delegation.*already exists/i);
    } finally {
      await broker.shutdown();
    }
  });

  it("recovers lifecycle from durable spawn intent when the registry record is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-intent-"));
    const lifecycle = policy({ runTimeoutMs: 4_321, idleTimeoutMs: 1_234 });
    const store = new MailStore(join(root, "state", "mail.jsonl"));
    await store.init();
    await store.accept({
      id: "mail_lifecycle_intent",
      from: "main@gpt-5.4.com",
      to: "worker.intent@gpt-5.4.com",
      subject: "Recover",
      message: "Recover exact accepted policy.",
      priority: "low",
      kind: "request",
      requiresResponse: true,
      createdAt: new Date().toISOString(),
      deliveryState: "queued",
      lifecycleIntent: lifecycle,
    });
    const broker = await brokerWith(root, () => new FakeWorker());
    try {
      assert.deepEqual(broker.inspectAgent("worker.intent@gpt-5.4.com").lifecycle, lifecycle);
    } finally {
      await broker.shutdown();
    }
  });

  it("bounds a hanging worker factory before provider startup can hold the send", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-spawn-"));
    const broker = await brokerWith(root, async () => new Promise<FakeWorker>(() => undefined));
    try {
      const started = Date.now();
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "worker.spawn-timeout@gpt-5.4.com",
        subject: "Hang factory",
        message: "Factory never returns.",
        priority: "low",
        lifecycle: { spawnTimeoutMs: 150 },
      }), /LIFECYCLE_SPAWN_TIMEOUT/);
      assert.ok(Date.now() - started < 500);
      assert.match(broker.inspectAgent("worker.spawn-timeout@gpt-5.4.com").failure ?? "", /LIFECYCLE_SPAWN_TIMEOUT/);
    } finally {
      await broker.shutdown();
    }
  });

  it("bounds prompt acceptance and preserves the accepted request", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-prompt-"));
    class HangingPromptWorker extends FakeWorker {
      override async prompt(): Promise<void> { await new Promise<void>(() => undefined); }
    }
    const broker = await brokerWith(root, () => new HangingPromptWorker());
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.prompt-timeout@gpt-5.4.com",
        subject: "Hang prompt",
        message: "Acceptance never resolves.",
        priority: "low",
        lifecycle: { promptAcceptanceTimeoutMs: 150 },
      });
      assert.equal(sent.envelope.deliveryState, "delivered");
      assert.match(broker.inspectAgent(sent.envelope.to).failure ?? "", /LIFECYCLE_PROMPT_ACCEPTANCE_TIMEOUT/);
      assert.equal(broker.fetchUnanswered(sent.envelope.to).length, 1);
    } finally {
      await broker.shutdown();
    }
  });

  it("fails an active run after its resettable idle/stall deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-idle-"));
    const workers: FakeWorker[] = [];
    const broker = await brokerWith(root, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.idle-timeout@gpt-5.4.com",
        subject: "Stall",
        message: "Stop producing activity.",
        priority: "low",
        lifecycle: { runTimeoutMs: 2_000, idleTimeoutMs: 500 },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      workers[0]!.emit({ type: "activity", activity: { at: new Date().toISOString(), kind: "text", summary: "progress" } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "running", "activity resets the stall deadline");
      await eventually(() => assert.match(broker.inspectAgent(sent.envelope.to).failure ?? "", /LIFECYCLE_IDLE_TIMEOUT/));
    } finally {
      await broker.shutdown();
    }
  });

  it("fails and releases a hanging run at the absolute run deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-run-"));
    const workers: FakeWorker[] = [];
    const broker = await brokerWith(root, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.run-timeout@gpt-5.4.com",
        subject: "Hang",
        message: "Remain streaming.",
        priority: "low",
        lifecycle: { runTimeoutMs: 300, idleTimeoutMs: 2_000 },
      });
      await eventually(() => {
        const inspection = broker.inspectAgent(sent.envelope.to);
        assert.equal(inspection.state, "failed");
        assert.match(inspection.failure ?? "", /LIFECYCLE_RUN_TIMEOUT/);
        assert.equal(workers[0]?.disposed, true);
      });
      assert.equal(broker.fetchUnanswered(sent.envelope.to).length, 1, "accepted request remains an open obligation");
    } finally {
      await broker.shutdown();
    }
  });

  it("bounds hanging abort and dispose cleanup after a run timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-cleanup-"));
    class HangingCleanupWorker extends FakeWorker {
      override async abort(): Promise<void> { await new Promise<void>(() => undefined); }
      override async dispose(): Promise<void> { await new Promise<void>(() => undefined); }
    }
    const broker = await brokerWith(root, () => new HangingCleanupWorker());
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.cleanup-timeout@gpt-5.4.com",
        subject: "Hang cleanup",
        message: "Exercise bounded cleanup.",
        priority: "low",
        lifecycle: { runTimeoutMs: 150, idleTimeoutMs: 1_000, abortTimeoutMs: 50, disposeTimeoutMs: 50 },
      });
      await eventually(() => {
        const failure = broker.inspectAgent(sent.envelope.to).failure ?? "";
        assert.match(failure, /LIFECYCLE_RUN_TIMEOUT/);
        assert.match(failure, /LIFECYCLE_ABORT_TIMEOUT/);
        assert.match(failure, /LIFECYCLE_DISPOSE_TIMEOUT/);
      });
    } finally {
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("releases namespace ownership after known-clean shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-clean-shutdown-"));
    const first = await brokerWith(root, () => new FakeWorker());
    await first.shutdown();
    const second = await brokerWith(root, () => new FakeWorker());
    await second.shutdown();
  });

  it("bounds shutdown even when worker disposal never settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-shutdown-"));
    class HangingDisposeWorker extends FakeWorker {
      override async dispose(): Promise<void> { await new Promise<void>(() => undefined); }
    }
    const broker = await brokerWith(root, () => new HangingDisposeWorker(), {
      lifecycle: policy({ brokerShutdownTimeoutMs: 200, disposeTimeoutMs: 1_000 }),
    });
    await broker.send(broker.mainAddress, {
      to: "worker.shutdown-timeout@gpt-5.4.com",
      subject: "Start",
      message: "Create worker.",
      priority: "low",
    });
    const started = Date.now();
    await assert.rejects(broker.shutdown(), /LIFECYCLE_BROKER_SHUTDOWN.*TIMEOUT/);
    assert.ok(Date.now() - started < 1_000, "shutdown observes its global deadline");
    await assert.rejects(
      brokerWith(root, () => new FakeWorker()),
      /namespace is already owned.*pid/i,
      "unsafe late cleanup retains namespace ownership",
    );
  });
});
