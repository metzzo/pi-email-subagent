import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
        assert.equal(inspection.cleanup?.heldCapacity, true);
      });
      assert.equal((broker as any).workers.has(sent.envelope.to), false, "routing detaches immediately");
      assert.equal((broker as any).active.has(sent.envelope.to), true, "the exact active slot stays leased");

      let queuedId = "";
      await assert.rejects(async () => {
        const result = await broker.send(broker.mainAddress, {
          to: "worker.blocked-mutation@gpt-5.4.com",
          subject: "Queued safely",
          message: "Do not start while cleanup is unknown.",
          priority: "low",
        });
        queuedId = result.envelope.id;
      }, /cleanup.*quarantin|quiescence.*unknown/i);
      const queued = broker.mailStore.list().find((email) => email.to === "worker.blocked-mutation@gpt-5.4.com");
      assert.ok(queued?.id);
      queuedId = queued.id;
      assert.equal(queued.deliveryState, "queued");
      assert.equal(workers.length, 1, "no second writable worker starts under namespace quarantine");

      cleanup.resolve(verifiedCleanup());
      await eventually(() => {
        assert.equal((broker.inspectAgent(sent.envelope.to) as any).cleanup, undefined);
        assert.equal((broker as any).active.has(sent.envelope.to), false);
      });
      assert.equal(broker.mailStore.get(queuedId)?.deliveryState, "queued", "verified release does not lose accepted mail");
    } finally {
      cleanup.resolve(verifiedCleanup());
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("creates exactly one replacement after a timed-out restart receives late verified cleanup", async () => {
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
        assert.equal(workers.length, 2);
        const inspection = broker.inspectAgent(sent.envelope.to) as any;
        assert.equal(inspection.cleanup, undefined);
        assert.equal(inspection.state, "idle");
      });
      staleListener({ type: "failure", error: "stale cleanup callback" });
      assert.equal(broker.inspectAgent(sent.envelope.to).state, "idle");
      assert.equal(workers.length, 2, "late settlement creates one replacement only");
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
      heldCapacity: true,
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
      await assert.rejects(restored.send(restored.mainAddress, {
        to: sent.envelope.to, subject: "Retained", message: "Remain queued.", priority: "low",
      }), /cleanup.*quarantin|quiescence.*unknown/i);
      const retained = restored.mailStore.list().filter((email) => email.subject === "Retained");
      assert.equal(retained.length, 1);
      assert.equal(retained[0]?.deliveryState, "queued");
    } finally {
      await restored.shutdown().catch(() => undefined);
    }
  });
});
