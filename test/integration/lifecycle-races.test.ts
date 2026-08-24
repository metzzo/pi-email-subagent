import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { makeReplySubject } from "../../src/reply.ts";
import type { WorkerStartConfig } from "../../src/types.ts";
import { eventually, FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeBroker(root: string, factory: () => FakeWorker, mainAdapter = new FakeMainAdapter()) {
  return new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config: structuredClone(DEFAULT_CONFIG),
    models: [fakeModel("gpt-5.4")],
    mainAdapter,
    workerFactory: factory,
    projectTrusted: true,
  });
}

describe("broker lifecycle races", () => {
  it("cancels and disposes a worker that finishes restoration after shutdown starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-"));
    const initialWorkers: FakeWorker[] = [];
    const initial = makeBroker(root, () => {
      const worker = new FakeWorker();
      initialWorkers.push(worker);
      return worker;
    });
    await initial.init();
    await initial.send(initial.mainAddress, {
      to: "worker.restore-race@gpt-5.4.com", subject: "Persist", message: "Remain open.", priority: "low",
    });
    await initial.shutdown();

    const entered = deferred();
    const release = deferred();
    class DelayedStartWorker extends FakeWorker {
      override async start(config: WorkerStartConfig): Promise<void> {
        entered.resolve();
        await release.promise;
        await super.start(config);
      }
    }
    const late = new DelayedStartWorker();
    const restoring = makeBroker(root, () => late);
    const init = restoring.init();
    await entered.promise;
    const closing = restoring.shutdown();
    release.resolve();
    await assert.rejects(init, /cancelled by shutdown/);
    await closing;
    assert.equal(late.disposed, true);
  });

  it("invalidates and joins an old settlement continuation before stop or replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-settlement-owner-"));
    const enforcementEntered = deferred();
    const releaseEnforcement = deferred();
    class BlockingEnforcementWorker extends FakeWorker {
      override async prompt(message: string): Promise<void> {
        if (message.includes("mailbox-enforcement")) {
          enforcementEntered.resolve();
          await releaseEnforcement.promise;
        }
        await super.prompt(message);
      }
    }
    const workers: FakeWorker[] = [];
    const broker = makeBroker(root, () => {
      const worker = new BlockingEnforcementWorker();
      workers.push(worker);
      return worker;
    });
    await broker.init();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.settlement-owner@gpt-5.4.com", subject: "Finish", message: "Reply with send_email.", priority: "low",
      });
      workers[0]!.settle("Visible final text is not an email reply.");
      await enforcementEntered.promise;

      let stopFinished = false;
      const stopping = broker.stop(request.envelope.to).then(() => { stopFinished = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(stopFinished, false, "management joins the exact old settlement continuation");
      releaseEnforcement.resolve();
      await stopping;
      assert.equal(broker.inspectAgent(request.envelope.to).state, "stopped");
      assert.equal((broker as any).active.has(request.envelope.to), false);

      await broker.restart(request.envelope.to);
      assert.equal(workers.length, 2);
      const next = await broker.send(broker.mainAddress, {
        to: request.envelope.to, subject: "Replacement", message: "Queue behind exact obligation recovery.", priority: "low",
      });
      assert.equal(next.envelope.deliveryState, "queued");
      assert.match(workers[1]!.prompts[0]!, /mailbox-enforcement/);
      assert.deepEqual(
        broker.fetchUnanswered(request.envelope.to).map((email) => email.id),
        [request.envelope.id],
        "the original obligation remains open for explicit same-identity handling",
      );
    } finally {
      releaseEnforcement.resolve();
      await broker.shutdown();
    }
  });

  it("joins settlement persistence before restart and preserves replacement settlement ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-settlement-persist-owner-"));
    const workers: FakeWorker[] = [];
    const broker = makeBroker(root, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    await broker.init();
    const persistEntered = deferred();
    const releasePersist = deferred();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.settlement-persist@gpt-5.4.com", subject: "Persist", message: "Answer before settlement.", priority: "low",
      });
      await workers[0]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(request.envelope.id, request.envelope.subject),
        message: "Answered.",
        priority: "low",
      });
      const originalSave = broker.registryStore.save.bind(broker.registryStore);
      let savesAfterSettlement = 0;
      broker.registryStore.save = async (registry) => {
        savesAfterSettlement += 1;
        if (savesAfterSettlement === 2) {
          persistEntered.resolve();
          await releasePersist.promise;
        }
        await originalSave(registry);
      };
      workers[0]!.settle();
      await persistEntered.promise;

      let restartFinished = false;
      const restart = broker.restart(request.envelope.to).then(() => { restartFinished = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(restartFinished, false, "replacement waits for the exact old settlement persistence boundary");
      releasePersist.resolve();
      await restart;
      assert.equal(workers.length, 2);

      const replacementRequest = await broker.send(broker.mainAddress, {
        to: request.envelope.to, subject: "Replacement persist", message: "Settle only this generation.", priority: "low",
      });
      await workers[1]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(replacementRequest.envelope.id, replacementRequest.envelope.subject),
        message: "Replacement settled.",
        priority: "low",
      });
      workers[1]!.settle();
      await eventually(() => {
        assert.equal(broker.inspectAgent(request.envelope.to).state, "idle");
        assert.equal((broker as any).active.has(request.envelope.to), false);
      });
    } finally {
      releasePersist.resolve();
      await broker.shutdown();
    }
  });

  it("settles and cleans a long-lived reply waiter during shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-"));
    const broker = makeBroker(root, () => new FakeWorker());
    await broker.init();
    const request = await broker.send(broker.mainAddress, {
      to: "worker.wait-close@gpt-5.4.com", subject: "Wait", message: "Remain pending.", priority: "low",
    });
    const waiting = broker.waitForReplies([request.envelope.id], 300_000, true);
    await broker.shutdown();
    const result = await waiting;
    assert.equal(result.timedOut, true);
    assert.equal(result.items[0]?.state, "pending");
  });

  it("drains a queued address operation that is cancelled by shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-"));
    const entered = deferred();
    const release = deferred();
    class BlockingWorker extends FakeWorker {
      override async prompt(message: string): Promise<void> {
        entered.resolve();
        await release.promise;
        await super.prompt(message);
      }
    }
    const worker = new BlockingWorker();
    const broker = makeBroker(root, () => worker);
    await broker.init();
    const first = broker.send(broker.mainAddress, {
      to: "worker.close-queue@gpt-5.4.com", subject: "First", message: "Block acceptance.", priority: "low",
    });
    await entered.promise;
    const second = broker.send(broker.mainAddress, {
      to: "worker.close-queue@gpt-5.4.com", subject: "Second", message: "Wait on address lock.", priority: "low",
    });
    const closing = broker.shutdown();
    release.resolve();
    await Promise.race([
      closing,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("shutdown did not drain address operations")), 1_000)),
    ]);
    await first;
    await assert.rejects(second, /shutting down or not ready/);
    assert.equal(worker.disposed, true);
  });

  it("serializes prompt acceptance before replacement without duplicating delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-"));
    const promptEntered = deferred();
    const releasePrompt = deferred();
    class BlockingPromptWorker extends FakeWorker {
      blockNext = false;
      override async prompt(message: string): Promise<void> {
        if (this.blockNext) {
          this.blockNext = false;
          promptEntered.resolve();
          await releasePrompt.promise;
        }
        await super.prompt(message);
      }
    }
    const workers: BlockingPromptWorker[] = [];
    const broker = makeBroker(root, () => {
      const worker = new BlockingPromptWorker();
      workers.push(worker);
      return worker;
    });
    await broker.init();
    try {
      const first = await broker.send(broker.mainAddress, {
        to: "worker.prompt-race@gpt-5.4.com", subject: "Initial", message: "Answer.", priority: "low",
      });
      await workers[0]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(first.envelope.id, first.envelope.subject),
        message: "Initial complete.",
        priority: "low",
      });
      workers[0]!.settle();
      await eventually(() => assert.equal(broker.inspectAgent(first.envelope.to).state, "idle"));

      workers[0]!.blockNext = true;
      const send = broker.send(broker.mainAddress, {
        to: first.envelope.to, subject: "Delayed acceptance", message: "Replacement must receive this.", priority: "low",
      });
      await promptEntered.promise;
      let restartFinished = false;
      const restart = broker.restart(first.envelope.to).then(() => { restartFinished = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(restartFinished, false, "restart waits for the address's accepted delivery boundary");
      releasePrompt.resolve();
      const [result] = await Promise.all([send, restart]);
      assert.equal(workers.length, 2);
      assert.equal(workers[0]!.prompts.filter((prompt) => prompt.includes("Delayed acceptance")).length, 1);
      assert.equal(workers[1]!.prompts.length, 1);
      assert.match(workers[1]!.prompts[0]!, /mailbox-enforcement/);
      assert.doesNotMatch(workers[1]!.prompts[0]!, /Delayed acceptance/);
      assert.equal(broker.mailStore.get(result.envelope.id)?.deliveryState, "delivered");
      assert.equal(broker.inspectAgent(first.envelope.to).state, "running");
      assert.equal(broker.inspectAgent(first.envelope.to).failure, undefined);
    } finally {
      releasePrompt.resolve();
      await broker.shutdown();
    }
  });

  it("disposes restored workers when initialization fails after their creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-"));
    const initial = makeBroker(root, () => new FakeWorker());
    await initial.init();
    await initial.send(initial.mainAddress, {
      to: "worker.init-failure@gpt-5.4.com", subject: "Persist", message: "Restore me.", priority: "low",
    });
    await initial.shutdown();

    const workers: FakeWorker[] = [];
    const restoring = makeBroker(root, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const originalSave = restoring.registryStore.save.bind(restoring.registryStore);
    let saves = 0;
    restoring.registryStore.save = async (registry) => {
      saves += 1;
      if (saves === 3) throw new Error("post-restore persistence failed");
      await originalSave(registry);
    };
    await assert.rejects(restoring.init(), /post-restore persistence failed/);
    assert.equal(workers.length, 1);
    assert.equal(workers[0]?.disposed, true);
    await restoring.shutdown();
  });

  it("ignores lifecycle events retained from a replaced worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-stale-worker-"));
    const workers: FakeWorker[] = [];
    const broker = makeBroker(root, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    await broker.init();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.stale-tool@gpt-5.4.com", subject: "Run", message: "Keep the obligation open.", priority: "low",
      });
      const staleListener = [...workers[0]!.listeners][0]!;
      await broker.restart(request.envelope.to);
      const currentWatchdog = (broker as any).watchdogs.get(request.envelope.to);
      assert.ok(currentWatchdog?.idle);
      staleListener({
        type: "tool_lifecycle", phase: "start", toolCallId: "stale", toolName: "bash", at: new Date().toISOString(),
      } as never);
      staleListener({ type: "run_liveness", phase: "model_progress" } as never);
      staleListener({ type: "run_liveness", phase: "retry_start", delayMs: 60_000 } as never);
      assert.equal((broker as any).watchdogs.get(request.envelope.to)?.generation, currentWatchdog.generation);
      assert.equal((broker as any).watchdogs.get(request.envelope.to)?.idle, currentWatchdog.idle);
      assert.equal((broker as any).toolLifecycles.get(request.envelope.to)?.worker, workers[1]);
      assert.equal((broker as any).runLifecycles.get(request.envelope.to)?.worker, workers[1]);
    } finally {
      await broker.shutdown();
    }
  });

  it("rejects an already-invalidated idle callback after a tool start wins the race", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-idle-race-"));
    const worker = new FakeWorker();
    const broker = makeBroker(root, () => worker);
    await broker.init();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.idle-race@gpt-5.4.com",
        subject: "Race",
        message: "Start at the idle boundary.",
        priority: "low",
        lifecycle: { runTimeoutMs: 4_000, idleTimeoutMs: 2_000 },
      });
      const entry = (broker as any).watchdogs.get(request.envelope.to);
      worker.emit({
        type: "tool_lifecycle", phase: "start", toolCallId: "boundary", toolName: "bash", at: new Date().toISOString(),
      } as never);
      await (broker as any).expireWorker(
        request.envelope.to,
        entry.generation,
        "LIFECYCLE_IDLE_TIMEOUT",
        worker,
        entry.idleGeneration,
      );
      assert.equal(broker.inspectAgent(request.envelope.to).state, "running");
      assert.equal((broker as any).watchdogs.get(request.envelope.to)?.idle, undefined);
      worker.emit({
        type: "tool_lifecycle", phase: "end", toolCallId: "boundary", toolName: "bash", at: new Date().toISOString(),
      } as never);
      assert.ok((broker as any).watchdogs.get(request.envelope.to)?.idle);
    } finally {
      await broker.shutdown();
    }
  });

  it("keeps a claimed run timeout terminal when a tool end arrives during cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-run-race-"));
    const abortEntered = deferred();
    const releaseAbort = deferred();
    class BlockingAbortWorker extends FakeWorker {
      override async abort(): Promise<void> {
        abortEntered.resolve();
        await releaseAbort.promise;
        await super.abort();
      }
    }
    const worker = new BlockingAbortWorker();
    const broker = makeBroker(root, () => worker);
    await broker.init();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.run-race@gpt-5.4.com",
        subject: "Race",
        message: "End after timeout claim.",
        priority: "low",
        lifecycle: { runTimeoutMs: 10_000, idleTimeoutMs: 5_000 },
      });
      worker.emit({
        type: "tool_lifecycle", phase: "start", toolCallId: "boundary", toolName: "bash", at: new Date().toISOString(),
      } as never);
      const entry = (broker as any).watchdogs.get(request.envelope.to);
      const expiring = (broker as any).expireWorker(
        request.envelope.to,
        entry.generation,
        "LIFECYCLE_RUN_TIMEOUT",
        worker,
      );
      await abortEntered.promise;
      worker.emit({
        type: "tool_lifecycle", phase: "end", toolCallId: "boundary", toolName: "bash", at: new Date().toISOString(),
      } as never);
      assert.equal(broker.inspectAgent(request.envelope.to).state, "failed");
      assert.match(broker.inspectAgent(request.envelope.to).failure ?? "", /LIFECYCLE_RUN_TIMEOUT/);
      releaseAbort.resolve();
      await expiring;
      assert.match(broker.inspectAgent(request.envelope.to).failure ?? "", /LIFECYCLE_RUN_TIMEOUT/);
      assert.equal(broker.inspectAgent(request.envelope.to).cleanup?.state, "unknown");
      assert.equal((broker as any).watchdogs.has(request.envelope.to), false);
    } finally {
      releaseAbort.resolve();
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("quarantines stop when worker abort rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-"));
    class RejectingAbortWorker extends FakeWorker {
      override async abort(): Promise<void> { throw new Error("abort rejected"); }
    }
    const workers: FakeWorker[] = [];
    const broker = makeBroker(root, () => {
      const worker = new RejectingAbortWorker();
      workers.push(worker);
      return worker;
    });
    await broker.init();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.abort-reject@gpt-5.4.com", subject: "Run", message: "Remain active.", priority: "low",
      });
      await assert.rejects(broker.stop(request.envelope.to), /cleanup.*quarantin|quiescence.*unknown/i);
      assert.equal(workers[0]?.disposed, true);
      const inspection = broker.inspectAgent(request.envelope.to);
      assert.equal(inspection.state, "failed");
      assert.equal(inspection.cleanup?.state, "unknown");
      assert.equal((broker as any).active.has(request.envelope.to), true);
    } finally {
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("blocks restart when prior worker disposal reports an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-"));
    class RejectingDisposeWorker extends FakeWorker {
      override async dispose(): Promise<void> {
        await super.dispose();
        throw new Error("dispose reported after cleanup");
      }
    }
    const workers: FakeWorker[] = [];
    const broker = makeBroker(root, () => {
      const worker = workers.length === 0 ? new RejectingDisposeWorker() : new FakeWorker();
      workers.push(worker);
      return worker;
    });
    await broker.init();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.restart-cleanup@gpt-5.4.com", subject: "Run", message: "Restart safely.", priority: "low",
      });
      await assert.rejects(broker.restart(request.envelope.to), /cleanup.*quarantin|quiescence.*unknown/i);
      assert.equal(workers.length, 1);
      assert.equal(workers[0]?.disposed, true);
      const inspection = broker.inspectAgent(request.envelope.to);
      assert.equal(inspection.state, "failed");
      assert.equal(inspection.cleanup?.state, "unknown");
    } finally {
      await broker.shutdown().catch(() => undefined);
    }
  });

  it("serializes restart with send and keeps exactly one replacement worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-lifecycle-"));
    const disposeEntered = deferred();
    const releaseDispose = deferred();
    class BlockingDisposeWorker extends FakeWorker {
      block = false;
      override async dispose(): Promise<void> {
        if (this.block) {
          disposeEntered.resolve();
          await releaseDispose.promise;
        }
        await super.dispose();
      }
    }
    const workers: BlockingDisposeWorker[] = [];
    const broker = makeBroker(root, () => {
      const worker = new BlockingDisposeWorker();
      workers.push(worker);
      return worker;
    });
    await broker.init();
    try {
      const first = await broker.send(broker.mainAddress, {
        to: "worker.restart-race@gpt-5.4.com", subject: "Initial", message: "Answer.", priority: "low",
      });
      await workers[0]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(first.envelope.id, first.envelope.subject),
        message: "Initial complete.",
        priority: "low",
      });
      workers[0]!.settle();
      await eventually(() => assert.equal(broker.inspectAgent(first.envelope.to).state, "idle"));

      workers[0]!.block = true;
      const restart = broker.restart(first.envelope.to);
      await disposeEntered.promise;
      const send = broker.send(broker.mainAddress, {
        to: first.envelope.to, subject: "After restart", message: "Only replacement handles this.", priority: "low",
      });
      releaseDispose.resolve();
      await Promise.all([restart, send]);
      assert.equal(workers.length, 2);
      assert.equal(workers[0]!.disposed, true);
      assert.equal(workers[1]!.prompts.length, 1);
      assert.match(workers[1]!.prompts[0]!, /After restart/);
    } finally {
      releaseDispose.resolve();
      await broker.shutdown();
    }
  });
});
