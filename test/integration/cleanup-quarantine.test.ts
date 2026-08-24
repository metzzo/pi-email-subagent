import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { makeReplySubject } from "../../src/reply.ts";
import { eventually, FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function verifiedCleanup() {
  return {
    sessionDisposed: true,
    providerQuiescent: true,
    tools: [],
    quiescence: "verified",
    source: "test-worker-receipt",
    abort: "succeeded",
    dispose: "succeeded",
  } as const;
}

async function makeBroker(root: string, factory: () => FakeWorker, maxConcurrent = 1) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.maxConcurrent = maxConcurrent;
  const broker = new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config,
    models: [fakeModel("gpt-5.4")],
    mainAdapter: new FakeMainAdapter(),
    workerFactory: factory,
    projectTrusted: true,
  });
  await broker.init();
  return broker;
}

describe("worker cleanup quarantine", () => {
  it("detaches routing but holds active capacity and mutable scheduling until late verified cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-quarantine-"));
    const cleanup = deferred<any>();
    const entered = deferred<void>();
    const workers: FakeWorker[] = [];
    class DeferredCleanupWorker extends FakeWorker {
      cleanup(): Promise<any> { entered.resolve(); return cleanup.promise; }
      override async dispose(): Promise<void> { entered.resolve(); await cleanup.promise; await super.dispose(); }
    }
    const broker = await makeBroker(root, () => {
      const worker = new DeferredCleanupWorker();
      workers.push(worker);
      return worker;
    });
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.cleanup-owner@gpt-5.4.com",
        subject: "Timeout",
        message: "Hold cleanup ownership.",
        priority: "low",
        lifecycle: { runTimeoutMs: 150, idleTimeoutMs: 2_000, abortTimeoutMs: 50, disposeTimeoutMs: 75 },
      });
      await entered.promise;
      await eventually(() => {
        const inspection = broker.inspectAgent(sent.envelope.to) as any;
        assert.equal(inspection.state, "failed");
        assert.equal(inspection.cleanup?.state, "unknown");
        assert.equal(inspection.cleanup?.heldRunSlot, true);
      });
      assert.equal((broker as any).workers.has(sent.envelope.to), false, "routing detaches immediately");
      assert.equal((broker as any).active.has(sent.envelope.to), true, "the exact active slot stays leased");

      const queuedResult = await broker.send(broker.mainAddress, {
        to: "worker.blocked-mutation@gpt-5.4.com",
        subject: "Queued safely",
        message: "Do not start while cleanup is unknown.",
        priority: "low",
      });
      const queuedId = queuedResult.envelope.id;
      const queued = broker.mailStore.get(queuedId);
      assert.equal(queued?.deliveryState, "queued");
      assert.equal(queuedResult.recipientState, "queued");
      assert.equal(workers.length, 1, "no second writable worker starts under namespace quarantine");

      cleanup.resolve(verifiedCleanup());
      await eventually(() => {
        assert.equal((broker.inspectAgent(sent.envelope.to) as any).cleanup, undefined);
        assert.equal((broker as any).active.has(sent.envelope.to), false);
        assert.equal(broker.mailStore.get(queuedId)?.deliveryState, "delivered");
      });
      assert.equal(workers.length, 2, "the durable deferred identity is materialized exactly once after release");
      assert.equal(workers[1]!.prompts.filter((prompt) => prompt.includes(queuedId)).length, 1);
      assert.equal(broker.mailStore.list().filter((email) => email.id === queuedId).length, 1, "stable accepted ID is not resent");
    } finally {
      cleanup.resolve(verifiedCleanup());
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("revalidates quarantine after markDelivered and resumes the retained admission after release", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-admission-"));
    const cleanup = deferred<any>();
    const workers: FakeWorker[] = [];
    class DeferredCleanupWorker extends FakeWorker {
      cleanup(): Promise<any> { return cleanup.promise; }
      override async dispose(): Promise<void> { await cleanup.promise; await super.dispose(); }
    }
    const broker = await makeBroker(root, () => {
      const worker = workers.length === 1 ? new DeferredCleanupWorker() : new FakeWorker();
      workers.push(worker);
      return worker;
    }, 3);
    try {
      const first = await broker.send(broker.mainAddress, {
        to: "worker.admission-target@gpt-5.4.com", subject: "Initial", message: "Become idle.", priority: "low",
      });
      await workers[0]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(first.envelope.id, first.envelope.subject),
        message: "Initial done.",
        priority: "low",
      });
      workers[0]!.settle();
      await eventually(() => assert.equal(broker.inspectAgent(first.envelope.to).state, "idle"));

      const owner = await broker.send(broker.mainAddress, {
        to: "worker.admission-owner@gpt-5.4.com", subject: "Own quarantine", message: "Remain active.", priority: "low",
      });
      const originalMark = broker.mailStore.markDelivered.bind(broker.mailStore);
      let inject = true;
      broker.mailStore.markDelivered = async (ids) => {
        await originalMark(ids);
        if (!inject) return;
        inject = false;
        (broker as any).beginWorkerCleanup(owner.envelope.to, workers[1], "TEST_ADMISSION_RACE", "paused");
      };

      const raced = await broker.send(broker.mainAddress, {
        to: first.envelope.to, subject: "Raced delivery", message: "Prompt only after release.", priority: "low",
      });
      assert.equal(raced.envelope.deliveryState, "delivered", "journal transition remains truthful and stable");
      assert.equal(workers[0]!.prompts.length, 1, "no prompt is admitted in the newer quarantine epoch");
      assert.equal((broker as any).pendingStarts.includes(first.envelope.to), true);

      cleanup.resolve(verifiedCleanup());
      await eventually(() => assert.equal(workers[0]!.prompts.length, 2));
      assert.match(workers[0]!.prompts[1]!, /mailbox-enforcement/);
      assert.equal(broker.mailStore.list().filter((email) => email.id === raced.envelope.id).length, 1);
    } finally {
      cleanup.resolve(verifiedCleanup());
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("revalidates quarantine between request delivery and high-priority steer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-steer-admission-"));
    const cleanup = deferred<any>();
    const workers: FakeWorker[] = [];
    class DeferredCleanupWorker extends FakeWorker {
      cleanup(): Promise<any> { return cleanup.promise; }
      override async dispose(): Promise<void> { await cleanup.promise; await super.dispose(); }
    }
    const broker = await makeBroker(root, () => {
      const worker = workers.length === 1 ? new DeferredCleanupWorker() : new FakeWorker();
      workers.push(worker);
      return worker;
    }, 3);
    try {
      const target = await broker.send(broker.mainAddress, {
        to: "worker.steer-target@gpt-5.4.com", subject: "Initial", message: "Remain streaming.", priority: "low",
      });
      const owner = await broker.send(broker.mainAddress, {
        to: "worker.steer-owner@gpt-5.4.com", subject: "Own quarantine", message: "Remain active.", priority: "low",
      });
      const originalMark = broker.mailStore.markDelivered.bind(broker.mailStore);
      let inject = true;
      broker.mailStore.markDelivered = async (ids) => {
        await originalMark(ids);
        if (!inject) return;
        inject = false;
        (broker as any).beginWorkerCleanup(owner.envelope.to, workers[1], "TEST_STEER_ADMISSION_RACE", "paused");
      };

      const high = await broker.send(broker.mainAddress, {
        to: target.envelope.to, subject: "High raced", message: "Do not steer in quarantine.", priority: "high",
      });
      assert.equal(high.envelope.deliveryState, "delivered");
      assert.equal(workers[0]!.steers.length, 0, "the newer epoch blocks synchronous steer admission");
      workers[0]!.settle();
      await eventually(() => {
        assert.equal((broker as any).active.has(target.envelope.to), false);
        assert.equal((broker as any).pendingStarts.includes(target.envelope.to), true);
      });

      cleanup.resolve(verifiedCleanup());
      await eventually(() => assert.equal(workers[0]!.prompts.length, 2));
      assert.match(workers[0]!.prompts[1]!, /mailbox-enforcement/);
      assert.equal(broker.mailStore.list().filter((email) => email.id === high.envelope.id).length, 1);
    } finally {
      cleanup.resolve(verifiedCleanup());
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("leaves a timed-out restart paused after late verified cleanup until an explicit restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-late-restart-"));
    const cleanup = deferred<any>();
    const entered = deferred<void>();
    const workers: FakeWorker[] = [];
    class DeferredRestartWorker extends FakeWorker {
      cleanup(): Promise<any> { entered.resolve(); return cleanup.promise; }
      override async dispose(): Promise<void> { entered.resolve(); await cleanup.promise; await super.dispose(); }
    }
    const broker = await makeBroker(root, () => {
      const worker = workers.length === 0 ? new DeferredRestartWorker() : new FakeWorker();
      workers.push(worker);
      return worker;
    });
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.late-restart@gpt-5.4.com", subject: "Complete", message: "Answer before restart.", priority: "low",
        lifecycle: { abortTimeoutMs: 50, disposeTimeoutMs: 75 },
      });
      await workers[0]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(sent.envelope.id, sent.envelope.subject),
        message: "Done.",
        priority: "low",
      });
      workers[0]!.settle();
      await eventually(() => assert.equal(broker.inspectAgent(sent.envelope.to).state, "idle"));
      const staleListener = [...workers[0]!.listeners][0]!;

      await assert.rejects(broker.restart(sent.envelope.to), /LIFECYCLE_DISPOSE_TIMEOUT|cleanup.*quarantin/i);
      await entered.promise;
      assert.equal(workers.length, 1, "replacement is prohibited before proof");
      assert.equal((broker.inspectAgent(sent.envelope.to) as any).cleanup?.state, "unknown");

      cleanup.resolve(verifiedCleanup());
      await eventually(() => {
        assert.equal(workers.length, 1, "late cleanup never creates a hidden replacement");
        const inspection = broker.inspectAgent(sent.envelope.to) as any;
        assert.equal(inspection.cleanup, undefined);
        assert.equal(inspection.state, "paused");
      });
      staleListener({ type: "failure", error: "stale cleanup callback" });
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "paused");
      assert.equal(workers.length, 1);

      await broker.restart(sent.envelope.to);
      assert.equal(workers.length, 2, "an explicit second restart creates the replacement");
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "idle");
    } finally {
      cleanup.resolve(verifiedCleanup());
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("keeps late cleanup rejection sticky and blocks archive and clear-failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-reject-"));
    const cleanup = deferred<any>();
    const entered = deferred<void>();
    class RejectingCleanupWorker extends FakeWorker {
      cleanup(): Promise<any> { entered.resolve(); return cleanup.promise; }
      override async dispose(): Promise<void> { entered.resolve(); await cleanup.promise; }
    }
    const worker = new RejectingCleanupWorker();
    const broker = await makeBroker(root, () => worker);
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.archive-cleanup@gpt-5.4.com", subject: "Complete", message: "Answer first.", priority: "low",
        lifecycle: { abortTimeoutMs: 50, disposeTimeoutMs: 75 },
      });
      await worker.send({
        to: broker.mainAddress,
        subject: makeReplySubject(sent.envelope.id, sent.envelope.subject),
        message: "Done.",
        priority: "low",
      });
      worker.settle();
      await eventually(() => assert.equal(broker.inspectAgent(sent.envelope.to).state, "idle"));

      await assert.rejects(broker.archive(sent.envelope.to), /cleanup|quiescence|LIFECYCLE_DISPOSE_TIMEOUT/i);
      await entered.promise;
      cleanup.reject(new Error("late cleanup rejected"));
      await eventually(() => {
        const inspection = broker.inspectAgent(sent.envelope.to) as any;
        assert.equal(inspection.cleanup?.state, "unknown");
        assert.equal(inspection.cleanup?.detail, "WORKER_CLEANUP_REJECTED");
      });
      await assert.rejects(broker.clearFailure(sent.envelope.to), /cleanup.*quarantin|quiescence.*unknown/i);
      await assert.rejects(broker.archive(sent.envelope.to), /cleanup.*quarantin|quiescence.*unknown/i);
      assert.equal((broker as any).activationLeases.has(sent.envelope.to), true);
      await assert.rejects(broker.shutdown(), /cleanup.*quarantin|quiescence.*unknown/i);
      await assert.rejects(makeBroker(root, () => new FakeWorker()), /namespace is already owned.*pid/i);
    } finally {
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("retains the in-memory safety lease when verified-release persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-persist-failure-"));
    const worker = new FakeWorker();
    const broker = await makeBroker(root, () => worker);
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.cleanup-persist@gpt-5.4.com", subject: "Persist release", message: "Remain active.", priority: "low",
      });
      const originalSave = broker.registryStore.save.bind(broker.registryStore);
      let rejectedRelease = false;
      broker.registryStore.save = async (registry) => {
        const candidate = registry.agents.find((agent) => agent.address === sent.envelope.to);
        if (!rejectedRelease && candidate?.state === "stopped" && !candidate.cleanup) {
          rejectedRelease = true;
          throw new Error("verified release persistence failed");
        }
        await originalSave(registry);
      };
      await assert.rejects(broker.stop(sent.envelope.to), /cleanup.*quarantin|quiescence.*unknown/i);
      await eventually(() => {
        const inspection = broker.inspectAgent(sent.envelope.to) as any;
        assert.equal(inspection.cleanup?.state, "unknown");
        assert.equal(inspection.cleanup?.detail, "CLEANUP_RELEASE_PERSIST_FAILED");
      });
      assert.equal((broker as any).active.has(sent.envelope.to), true);
      assert.equal((broker as any).activationLeases.has(sent.envelope.to), true);
      assert.equal((broker as any).cleanupQuarantines.has(sent.envelope.to), true);
    } finally {
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("reconstructs exact cleanup capability and inherited run slots before current read-only profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-reconstruct-"));
    const first = await makeBroker(root, () => new FakeWorker(), 2);
    await first.send(first.mainAddress, {
      to: "worker.cleanup-old-one@gpt-5.4.com", subject: "One", message: "Persist one.", priority: "low",
    });
    await first.send(first.mainAddress, {
      to: "worker.cleanup-old-two@gpt-5.4.com", subject: "Two", message: "Persist two.", priority: "low",
    });
    await first.shutdown();

    const registryPath = join(root, "state", "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as any;
    const now = new Date().toISOString();
    for (let index = 0; index < registry.agents.length; index += 1) {
      registry.agents[index].state = "failed";
      registry.agents[index].cleanup = {
        state: "unknown",
        reasonCode: "PERSISTED_TEST_CLEANUP",
        workerGeneration: index + 1,
        startedAt: now,
        updatedAt: now,
        abort: "timed-out",
        dispose: "timed-out",
        quiescence: "unknown",
        mutationCapableAtStart: true,
        heldRunSlot: true,
        activeTools: [],
      };
    }
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const config = structuredClone(DEFAULT_CONFIG);
    config.maxAgents = 3;
    config.maxConcurrent = 1;
    config.roles.worker!.tools = ["read", "send_email", "fetch_emails"];
    config.addresses["worker.mutable-after-restore@gpt-5.4.com"] = {
      tools: ["read", "bash", "send_email", "fetch_emails"],
    };
    const workers: FakeWorker[] = [];
    const restored = new AgentBroker({
      cwd: root,
      agentDir: root,
      namespaceDir: join(root, "state"),
      config,
      models: [fakeModel("gpt-5.4")],
      mainAdapter: new FakeMainAdapter(),
      workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
      projectTrusted: true,
    });
    await restored.init();
    try {
      assert.equal((restored as any).active.size, 2, "both exact inherited slots survive maxConcurrent reduction");
      assert.equal(restored.getSnapshot().capacity.runSlotsUsed, 2);
      for (const record of restored.getSnapshot().agents) {
        assert.equal(record.tools.includes("bash"), false, "current read-only profile is visible");
        assert.equal(record.cleanup?.mutationCapableAtStart, true, "old generation capability is not overwritten");
        assert.equal(record.cleanup?.heldRunSlot, true);
      }
      const accepted = await restored.send(restored.mainAddress, {
        to: "worker.mutable-after-restore@gpt-5.4.com", subject: "Deferred", message: "Do not admit over inherited slots.", priority: "low",
      });
      assert.equal(accepted.envelope.deliveryState, "queued");
      assert.equal(workers.length, 0);
      assert.equal((restored as any).active.size, 2, "ordinary work does not consume or replace inherited holds");
    } finally {
      await restored.shutdown().catch(() => undefined);
    }
  });

  it("restores a persisted unknown cleanup fail-closed and preserves newly accepted mail", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-restore-"));
    const firstWorkers: FakeWorker[] = [];
    const first = await makeBroker(root, () => {
      const worker = new FakeWorker();
      firstWorkers.push(worker);
      return worker;
    });
    const sent = await first.send(first.mainAddress, {
      to: "worker.persisted-cleanup@gpt-5.4.com", subject: "Persist", message: "Persist identity.", priority: "low",
    });
    await first.shutdown();

    const registryPath = join(root, "state", "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as any;
    const now = new Date().toISOString();
    registry.agents[0].state = "failed";
    registry.agents[0].cleanup = {
      state: "pending",
      reasonCode: "LIFECYCLE_RUN_TIMEOUT",
      workerGeneration: 9,
      startedAt: now,
      updatedAt: now,
      abort: "pending",
      dispose: "pending",
      quiescence: "unknown",
      mutationCapableAtStart: true,
      heldRunSlot: true,
      activeTools: [{ toolCallId: "bash-9", toolName: "bash" }],
      detail: "Original process ended before cleanup settled.",
    };
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const restoredWorkers: FakeWorker[] = [];
    const restored = await makeBroker(root, () => {
      const worker = new FakeWorker();
      restoredWorkers.push(worker);
      return worker;
    });
    try {
      const inspection = restored.inspectAgent(sent.envelope.to) as any;
      assert.equal(restoredWorkers.length, 0);
      assert.equal(inspection.cleanup?.state, "unknown");
      assert.equal((restored as any).activationLeases.has(sent.envelope.to), true);
      assert.equal((restored as any).active.has(sent.envelope.to), true);
      assert.match(inspection.cleanup?.detail ?? "", /process restart|promise owner|owner/i);
      await assert.rejects(restored.restart(sent.envelope.to), /cleanup.*quarantin|quiescence.*unknown/i);
      const accepted = await restored.send(restored.mainAddress, {
        to: sent.envelope.to, subject: "Retained", message: "Remain queued.", priority: "low",
      });
      assert.equal(accepted.envelope.deliveryState, "queued");
      const retained = restored.mailStore.list().filter((email) => email.subject === "Retained");
      assert.equal(retained.length, 1);
      assert.equal(retained[0]?.deliveryState, "queued");
    } finally {
      await restored.shutdown().catch(() => undefined);
    }
  });
});
