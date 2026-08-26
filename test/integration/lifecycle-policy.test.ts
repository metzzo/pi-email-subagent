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

  it("quarantines the exact timed-out factory generation until it settles and cleans", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-spawn-"));
    let resolveFactory!: (worker: FakeWorker) => void;
    const firstFactory = new Promise<FakeWorker>((resolve) => { resolveFactory = resolve; });
    let factoryCalls = 0;
    const broker = await brokerWith(root, () => {
      factoryCalls += 1;
      return factoryCalls === 1 ? firstFactory : new FakeWorker();
    });
    try {
      const started = Date.now();
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "worker.spawn-timeout@gpt-5.4.com",
        subject: "Hang factory",
        message: "Factory returns after its generation deadline.",
        priority: "low",
        lifecycle: { spawnTimeoutMs: 150 },
      }), /LIFECYCLE_SPAWN_TIMEOUT/);
      assert.ok(Date.now() - started < 500);
      const inspection = broker.inspectAgent("worker.spawn-timeout@gpt-5.4.com");
      assert.match(inspection.failure ?? "", /LIFECYCLE_SPAWN_TIMEOUT/);
      assert.equal(inspection.cleanup?.workerGeneration, 1);
      await assert.rejects(broker.restart(inspection.address), /Pi session\/tool cleanup settlement is unknown/i);
      assert.equal(factoryCalls, 1, "explicit restart cannot create generation 2 while generation 1 factory is pending");

      const late = new FakeWorker();
      resolveFactory(late);
      await eventually(() => assert.equal(broker.inspectAgent(inspection.address).cleanup, undefined));
      assert.equal(late.disposed, true, "the exact late generation was cleaned before quarantine release");
      await broker.restart(inspection.address);
      assert.equal(factoryCalls, 2);
      assert.equal(broker.inspectAgent(inspection.address).state, "running", "queued accepted mail resumes only in generation 2");
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

  it("treats coalesced model progress as pulses without turning model start into a hold", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-model-pulse-"));
    const worker = new FakeWorker();
    const broker = await brokerWith(root, () => worker);
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.model-pulse@gpt-5.4.com",
        subject: "Stream",
        message: "Emit content-free progress.",
        priority: "low",
        lifecycle: { runTimeoutMs: 3_000, idleTimeoutMs: 300 },
      });
      const activityBefore = broker.getSnapshot().agents[0]!.activity.length;
      worker.emit({ type: "run_liveness", phase: "model_start" } as never);
      for (let index = 0; index < 4; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 180));
        worker.emit({ type: "run_liveness", phase: "model_progress" } as never);
      }
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "running");
      assert.equal(broker.getSnapshot().agents[0]!.activity.length, activityBefore, "ephemeral pulses never enter registry activity");
      await eventually(() => assert.match(broker.inspectAgent(sent.envelope.to).failure ?? "", /LIFECYCLE_IDLE_TIMEOUT/));
    } finally {
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("expires a model start that never produces progress or an end", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-model-stall-"));
    const worker = new FakeWorker();
    const broker = await brokerWith(root, () => worker);
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.model-stall@gpt-5.4.com",
        subject: "Stall",
        message: "Start without progress.",
        priority: "low",
        lifecycle: { runTimeoutMs: 2_000, idleTimeoutMs: 200 },
      });
      worker.emit({ type: "run_liveness", phase: "model_start" } as never);
      await eventually(() => assert.match(broker.inspectAgent(sent.envelope.to).failure ?? "", /LIFECYCLE_IDLE_TIMEOUT/));
    } finally {
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("uses Pi retry delay as a bounded hold and clears it on the next attempt boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-retry-hold-"));
    const worker = new FakeWorker();
    const broker = await brokerWith(root, () => worker);
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.retry-hold@gpt-5.4.com",
        subject: "Retry",
        message: "Wait for Pi's retry boundary.",
        priority: "low",
        lifecycle: { runTimeoutMs: 3_000, idleTimeoutMs: 200 },
      });
      worker.emit({ type: "run_liveness", phase: "retry_start", delayMs: 600 } as never);
      assert.equal((broker as any).watchdogs.get(sent.envelope.to)?.idle, undefined);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "running", "finite retry delay may outlive ordinary idle");
      worker.emit({ type: "run_liveness", phase: "model_start" } as never);
      assert.ok((broker as any).watchdogs.get(sent.envelope.to)?.idle, "the next exact attempt boundary clears the retry hold");
      await eventually(() => assert.match(broker.inspectAgent(sent.envelope.to).failure ?? "", /LIFECYCLE_IDLE_TIMEOUT/));
    } finally {
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("expires a bounded retry hold when Pi emits no end or next attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-retry-missing-end-"));
    const worker = new FakeWorker();
    const broker = await brokerWith(root, () => worker);
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.retry-missing-end@gpt-5.4.com",
        subject: "Retry missing end",
        message: "Do not hold forever.",
        priority: "low",
        lifecycle: { runTimeoutMs: 3_000, idleTimeoutMs: 150 },
      });
      worker.emit({ type: "run_liveness", phase: "retry_start", delayMs: 250 } as never);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "running");
      await eventually(() => assert.match(broker.inspectAgent(sent.envelope.to).failure ?? "", /LIFECYCLE_IDLE_TIMEOUT/), 1_500);
    } finally {
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("keeps the run deadline absolute across model progress and retry holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-run-absolute-"));
    const worker = new FakeWorker();
    const broker = await brokerWith(root, () => worker);
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.run-absolute@gpt-5.4.com",
        subject: "Absolute run",
        message: "Progress must not move the run deadline.",
        priority: "low",
        lifecycle: { runTimeoutMs: 450, idleTimeoutMs: 175 },
      });
      worker.emit({ type: "run_liveness", phase: "retry_start", delayMs: 1_000 } as never);
      const pulse = setInterval(() => worker.emit({ type: "run_liveness", phase: "model_progress" } as never), 75);
      try {
        await eventually(() => {
          const failure = broker.inspectAgent(sent.envelope.to).failure ?? "";
          assert.match(failure, /LIFECYCLE_RUN_TIMEOUT/);
          assert.doesNotMatch(failure, /LIFECYCLE_IDLE_TIMEOUT/);
        }, 1_500);
      } finally {
        clearInterval(pulse);
      }
    } finally {
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("disarms idle while a known tool is active and rearms a full interval after its end", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-active-tool-"));
    const workers: FakeWorker[] = [];
    const broker = await brokerWith(root, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.active-tool@gpt-5.4.com",
        subject: "Long tool",
        message: "Run a silent tool.",
        priority: "low",
        lifecycle: { runTimeoutMs: 3_000, idleTimeoutMs: 500 },
      });
      workers[0]!.emit({
        type: "tool_lifecycle", phase: "start", toolCallId: "bash-1", toolName: "bash", at: new Date().toISOString(),
      } as never);
      const watchdog = (broker as any).watchdogs.get(sent.envelope.to);
      assert.ok(watchdog?.run, "absolute run timer remains armed");
      assert.equal(watchdog?.idle, undefined, "active tool disarms only idle");
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "running");

      const endedAt = Date.now();
      workers[0]!.emit({
        type: "tool_lifecycle", phase: "end", toolCallId: "bash-1", toolName: "bash", at: new Date().toISOString(),
      } as never);
      assert.ok((broker as any).watchdogs.get(sent.envelope.to)?.idle, "last tool end rearms idle");
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "running", "last end receives a fresh idle interval");
      await eventually(() => assert.match(broker.inspectAgent(sent.envelope.to).failure ?? "", /LIFECYCLE_IDLE_TIMEOUT/));
      assert.ok(Date.now() - endedAt >= 450, "idle expiry is measured from the last tool end");
    } finally {
      await broker.shutdown();
    }
  });

  it("waits for the last exact parallel tool-call ID and ignores duplicate or orphan boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-parallel-tools-"));
    const workers: FakeWorker[] = [];
    const broker = await brokerWith(root, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.parallel-tools@gpt-5.4.com",
        subject: "Parallel tools",
        message: "Run two tools.",
        priority: "low",
        lifecycle: { runTimeoutMs: 4_000, idleTimeoutMs: 500 },
      });
      const emit = (phase: "start" | "end", toolCallId: string) => workers[0]!.emit({
        type: "tool_lifecycle", phase, toolCallId, toolName: "bash",
      } as never);
      emit("start", "call-a");
      emit("start", "call-a");
      emit("start", "call-b");
      emit("end", "orphan");
      emit("end", "call-a");
      emit("end", "call-a");
      assert.equal((broker as any).watchdogs.get(sent.envelope.to)?.idle, undefined);
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "running", "remaining exact call keeps idle disarmed");
      emit("end", "call-b");
      assert.ok((broker as any).watchdogs.get(sent.envelope.to)?.idle);
      await eventually(() => assert.match(broker.inspectAgent(sent.envelope.to).failure ?? "", /LIFECYCLE_IDLE_TIMEOUT/));
    } finally {
      await broker.shutdown();
    }
  });

  it("captures a tool start emitted before watchdog installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-pre-watchdog-tool-"));
    class ImmediateToolWorker extends FakeWorker {
      override async prompt(message: string): Promise<void> {
        this.emit({
          type: "tool_lifecycle", phase: "start", toolCallId: "early", toolName: "bash", at: new Date().toISOString(),
        } as never);
        await super.prompt(message);
      }
    }
    const worker = new ImmediateToolWorker();
    const broker = await brokerWith(root, () => worker);
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.pre-watchdog@gpt-5.4.com",
        subject: "Immediate tool",
        message: "Start immediately.",
        priority: "low",
        lifecycle: { runTimeoutMs: 3_000, idleTimeoutMs: 500 },
      });
      const watchdog = (broker as any).watchdogs.get(sent.envelope.to);
      assert.ok(watchdog?.run);
      assert.equal(watchdog?.idle, undefined);
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "running");
      worker.emit({
        type: "tool_lifecycle", phase: "end", toolCallId: "early", toolName: "bash", at: new Date().toISOString(),
      } as never);
      await eventually(() => assert.match(broker.inspectAgent(sent.envelope.to).failure ?? "", /LIFECYCLE_IDLE_TIMEOUT/));
    } finally {
      await broker.shutdown();
    }
  });

  it("keeps the run timeout terminal after fake cleanup reports session/tool settlement", async () => {
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
      workers[0]!.emit({
        type: "tool_lifecycle", phase: "start", toolCallId: "hung-tool", toolName: "bash", at: new Date().toISOString(),
      } as never);
      assert.equal((broker as any).watchdogs.get(sent.envelope.to)?.idle, undefined);
      await eventually(() => {
        const inspection = broker.inspectAgent(sent.envelope.to);
        assert.equal(inspection.state, "failed");
        assert.match(inspection.failure ?? "", /LIFECYCLE_RUN_TIMEOUT/);
        assert.equal(inspection.cleanup, undefined);
        assert.equal(workers[0]?.disposed, true);
      });
      assert.equal((broker as any).active.has(sent.envelope.to), false, "settled cleanup releases the exact run slot");
      assert.equal(broker.fetchUnanswered(sent.envelope.to).length, 1, "accepted request remains an open obligation");
    } finally {
      await broker.shutdown().catch(() => undefined);
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
