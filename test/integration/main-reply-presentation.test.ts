import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { makeReplySubject } from "../../src/reply.ts";
import type { MainDelivery, SubagentConfig } from "../../src/types.ts";
import { createWorkerFactory, FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

async function setup(
  main = new FakeMainAdapter(),
  root?: string,
  configOverrides: Partial<SubagentConfig> = {},
) {
  const namespace = root ?? await mkdtemp(join(tmpdir(), "pi-email-main-presentation-"));
  const workers: FakeWorker[] = [];
  const broker = new AgentBroker({
    cwd: namespace,
    agentDir: namespace,
    namespaceDir: join(namespace, "state"),
    config: { ...structuredClone(DEFAULT_CONFIG), ...configOverrides },
    models: [fakeModel("gpt-5.4")],
    mainAdapter: main,
    workerFactory: createWorkerFactory(workers),
    projectTrusted: true,
  });
  await broker.init();
  return { broker, main, workers, root: namespace };
}

async function requestAndReply(
  broker: AgentBroker,
  workers: FakeWorker[],
  priority: "high" | "low" = "low",
) {
  const request = await broker.send(broker.mainAddress, {
    to: "worker.main-presentation@gpt-5.4.com",
    subject: "Inspect presentation",
    message: "Return one correlated reply.",
    priority: "low",
  });
  const reply = await workers[0]!.send({
    to: broker.mainAddress,
    subject: makeReplySubject(request.envelope.id, request.envelope.subject),
    message: "Presentation result.",
    priority,
  });
  return { request, reply };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class BlockingMainAdapter extends FakeMainAdapter {
  block = false;
  entered!: Promise<void>;
  protected signalEntered!: () => void;
  protected releaseDelivery!: () => void;

  constructor() {
    super();
    this.resetGate();
  }

  resetGate(): void {
    this.entered = new Promise<void>((resolve) => { this.signalEntered = resolve; });
  }

  release(): void { this.releaseDelivery(); }

  override async deliver(delivery: MainDelivery): Promise<void> {
    if (this.block) {
      this.signalEntered();
      await new Promise<void>((resolve) => { this.releaseDelivery = resolve; });
    }
    await super.deliver(delivery);
  }
}

class BlockingRejectingMainAdapter extends BlockingMainAdapter {
  override async deliver(): Promise<void> {
    this.signalEntered();
    await new Promise<void>((resolve) => { this.releaseDelivery = resolve; });
    throw new Error("deterministic main delivery rejection");
  }
}

describe("deferred low-priority main presentation", () => {
  it("lets a late collector claim a low reply that arrived while main was busy", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main);
    try {
      const { request, reply } = await requestAndReply(broker, workers);
      assert.equal(reply.envelope.deliveryState, "queued");
      assert.equal(main.deliveries.length, 0, "busy low mail must not be handed to Pi as a follow-up");

      const joined = await broker.waitForReplies([request.correlationId], 0, true);
      assert.equal(joined.complete, true);
      assert.equal(joined.items[0]?.reply?.id, reply.envelope.id);
      assert.equal(main.snapshots.at(-1)?.queuedMail, 0, "late collection publishes the drained queue state");

      main.idle = true;
      await broker.flushQueuedMainMail();
      assert.equal(main.deliveries.length, 0, "the collected reply must not later become a custom message");
    } finally { await broker.shutdown(); }
  });

  it("flushes an uncollected low reply once when main settles", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main);
    try {
      const { request, reply } = await requestAndReply(broker, workers);
      assert.equal(reply.envelope.deliveryState, "queued");
      main.idle = true;
      await broker.flushQueuedMainMail();
      await broker.flushQueuedMainMail();

      assert.deepEqual(main.deliveries.map((delivery) => delivery.envelope.id), [reply.envelope.id]);
      assert.equal(broker.mailStore.get(reply.envelope.id)?.deliveryState, "delivered");
      assert.equal(broker.mailStore.get(request.envelope.id)?.answeredBy, reply.envelope.id);
    } finally { await broker.shutdown(); }
  });

  it("keeps high-priority main steering immediate while main is busy", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main);
    try {
      const { reply } = await requestAndReply(broker, workers, "high");
      assert.deepEqual(main.deliveries.map((delivery) => delivery.envelope.id), [reply.envelope.id]);
      assert.equal(reply.envelope.deliveryState, "delivered");
    } finally { await broker.shutdown(); }
  });

  it("presents low-priority main mail promptly when main is idle", async () => {
    const main = new FakeMainAdapter();
    const { broker, workers } = await setup(main);
    try {
      const { reply } = await requestAndReply(broker, workers);
      assert.deepEqual(main.deliveries.map((delivery) => delivery.envelope.id), [reply.envelope.id]);
      assert.equal(reply.envelope.deliveryState, "delivered");
    } finally { await broker.shutdown(); }
  });

  it("serializes collection against a settlement flush so only one path wins", async () => {
    const main = new BlockingMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main);
    try {
      const { request, reply } = await requestAndReply(broker, workers);
      main.idle = true;
      main.block = true;
      const flush = broker.flushQueuedMainMail();
      await main.entered;
      const collection = broker.waitForReplies([request.correlationId], 0, true);
      main.release();
      const [, joined] = await Promise.all([flush, collection]);

      assert.equal(joined.items[0]?.state, "answered");
      assert.equal(joined.items[0]?.reply, undefined, "the wait that lost presentation ownership omits the reply body");
      assert.deepEqual(main.deliveries.map((delivery) => delivery.envelope.id), [reply.envelope.id]);
      const recovery = await broker.waitForReplies([request.correlationId], 0, true);
      assert.equal(recovery.items[0]?.reply?.id, reply.envelope.id, "a later deliberate rejoin can recover the reply");
      await broker.flushQueuedMainMail();
      assert.equal(main.deliveries.length, 1);
    } finally { await broker.shutdown(); }
  });

  it("recovers queued main mail without presenting it while the restored main is busy", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-main-presentation-recovery-"));
    const firstMain = new FakeMainAdapter();
    firstMain.idle = false;
    const first = await setup(firstMain, root);
    const { request, reply } = await requestAndReply(first.broker, first.workers);
    assert.equal(reply.envelope.deliveryState, "queued");
    await first.broker.shutdown();

    const restoredMain = new FakeMainAdapter();
    restoredMain.idle = false;
    const restored = await setup(restoredMain, root);
    try {
      assert.equal(restoredMain.deliveries.length, 0);
      assert.equal(restored.broker.mailStore.get(reply.envelope.id)?.deliveryState, "queued");
      const joined = await restored.broker.waitForReplies([request.correlationId], 0, true);
      assert.equal(joined.items[0]?.reply?.id, reply.envelope.id);
      assert.equal(restoredMain.deliveries.length, 0);
    } finally { await restored.broker.shutdown(); }
  });

  it("bounds busy-main low mail by aggregate queued count while exempting high mail", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main, undefined, { maxQueuedMessages: 1 });
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.main-count@gpt-5.4.com", subject: "Start", message: "Start.", priority: "low",
      });
      await workers[0]!.send({ to: broker.mainAddress, subject: "Queued one", message: "one", priority: "low" });
      await assert.rejects(
        workers[0]!.send({ to: broker.mainAddress, subject: "Queued two", message: "two", priority: "low" }),
        /mailbox queue.*full/i,
      );
      const high = await workers[0]!.send({
        to: broker.mainAddress, subject: "Urgent blocker", message: "high bypass", priority: "high",
      });
      assert.equal(high.envelope.deliveryState, "delivered");
      assert.equal(main.deliveries.at(-1)?.envelope.id, high.envelope.id);
    } finally { await broker.shutdown(); }
  });

  it("bounds busy-main low mail by aggregate queued bytes", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main, undefined, { maxQueuedBytes: 12 });
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.main-bytes@gpt-5.4.com", subject: "Start", message: "Start.", priority: "low",
      });
      await workers[0]!.send({ to: broker.mainAddress, subject: "a", message: "1234", priority: "low" });
      await assert.rejects(
        workers[0]!.send({ to: broker.mainAddress, subject: "bbbb", message: "5678", priority: "low" }),
        /mailbox queue.*full/i,
      );
    } finally { await broker.shutdown(); }
  });

  it("serializes parallel low admission across old and new main aliases", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main, undefined, { maxQueuedMessages: 1 });
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.main-parallel@gpt-5.4.com", subject: "Start", message: "Start.", priority: "low",
      });
      const oldMain = broker.mainAddress;
      const newMain = "main@gpt-next.com";
      await broker.updateMainModel(newMain);
      const outcomes = await Promise.allSettled([
        workers[0]!.send({ to: oldMain, subject: "Old alias", message: "old", priority: "low" }),
        workers[0]!.send({ to: newMain, subject: "New alias", message: "new", priority: "low" }),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
      assert.equal(broker.mailStore.queued(oldMain).length + broker.mailStore.queued(newMain).length, 1);
    } finally { await broker.shutdown(); }
  });

  it("counts a queued old-alias envelope against later new-alias admission", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main, undefined, { maxQueuedMessages: 1 });
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.main-alias@gpt-5.4.com", subject: "Start", message: "Start.", priority: "low",
      });
      const oldMain = broker.mainAddress;
      await workers[0]!.send({ to: oldMain, subject: "Historical alias", message: "old", priority: "low" });
      const newMain = "main@gpt-next.com";
      await broker.updateMainModel(newMain);
      await assert.rejects(
        workers[0]!.send({ to: newMain, subject: "Current alias", message: "new", priority: "low" }),
        /mailbox queue.*full/i,
      );
    } finally { await broker.shutdown(); }
  });

  it("leaves an accepted reply queued or delivered when orderly shutdown wins routing", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main);
    const request = await broker.send(broker.mainAddress, {
      to: "worker.main-shutdown@gpt-5.4.com", subject: "Race shutdown", message: "Reply once.", priority: "low",
    });
    const entered = deferred();
    const release = deferred();
    const reserveReply = broker.mailStore.reserveReply.bind(broker.mailStore);
    broker.mailStore.reserveReply = async (reply, originalId) => {
      await reserveReply(reply, originalId);
      entered.resolve();
      await release.promise;
    };
    const sending = workers[0]!.send({
      to: broker.mainAddress,
      subject: makeReplySubject(request.envelope.id, request.envelope.subject),
      message: "Durably accepted before shutdown.",
      priority: "low",
    });
    void sending.catch(() => undefined);
    await entered.promise;
    const shuttingDown = broker.shutdown();
    release.resolve();
    const [sendOutcome, shutdownOutcome] = await Promise.allSettled([sending, shuttingDown]);
    assert.equal(shutdownOutcome.status, "fulfilled");
    const reply = broker.mailStore.list().find((email) => email.inReplyTo === request.envelope.id);
    assert.ok(reply);
    assert.notEqual(reply.deliveryState, "failed");
    assert.ok(reply.deliveryState === "queued" || reply.deliveryState === "delivered");
    const original = broker.mailStore.get(request.envelope.id)!;
    if (reply.deliveryState === "queued") assert.equal(original.replyReservedBy, reply.id);
    else assert.equal(original.answeredBy, reply.id);
    assert.notEqual(sendOutcome.status === "rejected" ? String(sendOutcome.reason) : "", "Email broker is shutting down or not ready.");
  });

  it("presents a correlated high reply and ends its active multi-ID collector without duplicating the body", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main);
    try {
      const first = await broker.send(broker.mainAddress, {
        to: "worker.main-high@gpt-5.4.com", subject: "High result", message: "Reply high.", priority: "low",
      });
      const second = await broker.send(broker.mainAddress, {
        to: "reviewer.main-slow@gpt-5.4.com", subject: "Slow result", message: "Remain pending.", priority: "low",
      });
      const waiting = broker.waitForReplies([first.correlationId, second.correlationId], 1_000, true);
      const high = await workers[0]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(first.envelope.id, first.envelope.subject),
        message: "Immediate blocker body.",
        priority: "high",
      });
      const joined = await waiting;
      assert.equal(joined.timedOut, false);
      assert.equal(joined.complete, false);
      assert.equal(joined.items.find((item) => item.requestId === first.correlationId)?.state, "answered");
      assert.equal(joined.items.find((item) => item.requestId === first.correlationId)?.reply, undefined);
      assert.equal(joined.items.find((item) => item.requestId === second.correlationId)?.state, "pending");
      assert.equal(main.deliveries.at(-1)?.envelope.id, high.envelope.id);
      const recovery = await broker.waitForReplies([first.correlationId], 0, true);
      assert.equal(recovery.items[0]?.reply?.message, "Immediate blocker body.");
    } finally { await broker.shutdown(); }
  });

  it("lets collect:false observe ordinary high ownership and end a multi-ID wait partial", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main);
    try {
      const first = await broker.send(broker.mainAddress, {
        to: "worker.main-observe-high@gpt-5.4.com", subject: "Observed high", message: "Reply high.", priority: "low",
      });
      const second = await broker.send(broker.mainAddress, {
        to: "reviewer.main-observe-slow@gpt-5.4.com", subject: "Observed slow", message: "Remain pending.", priority: "low",
      });
      const waiting = broker.waitForReplies([first.correlationId, second.correlationId], 1_000, false);
      const high = await workers[0]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(first.envelope.id, first.envelope.subject),
        message: "Observed urgent body.",
        priority: "high",
      });
      const joined = await waiting;
      assert.equal(joined.timedOut, false);
      assert.equal(joined.complete, false);
      assert.equal(joined.items.find((item) => item.requestId === first.correlationId)?.reply, undefined);
      assert.equal(joined.items.find((item) => item.requestId === second.correlationId)?.state, "pending");
      assert.deepEqual(main.deliveries.map((delivery) => delivery.envelope.id), [high.envelope.id]);
      const recovery = await broker.waitForReplies([first.correlationId], 0, false);
      assert.equal(recovery.items[0]?.reply?.message, "Observed urgent body.");
    } finally { await broker.shutdown(); }
  });

  it("finalizes immediate main delivery failure before a late collector can answer from that reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-main-presentation-failure-race-"));
    const main = new BlockingRejectingMainAdapter();
    const first = await setup(main, root);
    let restored: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      const request = await first.broker.send(first.broker.mainAddress, {
        to: "worker.main-reject@gpt-5.4.com", subject: "Reject reply", message: "Reply once.", priority: "low",
      });
      let failedTransitions = 0;
      const markFailed = first.broker.mailStore.markFailed.bind(first.broker.mailStore);
      first.broker.mailStore.markFailed = async (id, error) => {
        failedTransitions += 1;
        await markFailed(id, error);
      };
      const sending = first.workers[0]!.send({
        to: first.broker.mainAddress,
        subject: makeReplySubject(request.envelope.id, request.envelope.subject),
        message: "This presentation rejects.",
        priority: "low",
      });
      void sending.catch(() => undefined);
      await main.entered;
      const waiting = first.broker.waitForReplies([request.correlationId], 0, true);
      main.release();
      const [sendOutcome, joined] = await Promise.all([sending.then(() => "fulfilled", () => "rejected"), waiting]);
      assert.equal(sendOutcome, "rejected");
      assert.equal(joined.items[0]?.state, "pending");
      const reply = first.broker.mailStore.list().find((email) => email.inReplyTo === request.envelope.id);
      assert.ok(reply);
      assert.equal(reply.deliveryState, "failed");
      assert.equal(failedTransitions, 1, "the serialized route finalizes failure exactly once");
      const original = first.broker.mailStore.get(request.envelope.id);
      assert.equal(original?.answeredAt, undefined);
      assert.equal(original?.answeredBy, undefined);
      assert.equal(original?.replyReservedBy, undefined);

      await first.broker.shutdown();
      restored = await setup(new FakeMainAdapter(), root);
      const reloadedReply = restored.broker.mailStore.get(reply.id);
      const reloadedOriginal = restored.broker.mailStore.get(request.envelope.id);
      assert.equal(reloadedReply?.deliveryState, "failed");
      assert.equal(reloadedOriginal?.answeredAt, undefined);
      assert.equal(reloadedOriginal?.answeredBy, undefined);
      assert.equal(reloadedOriginal?.replyReservedBy, undefined);
    } finally {
      await first.broker.shutdown().catch(() => undefined);
      await restored?.broker.shutdown().catch(() => undefined);
    }
  });

  it("owns a rejected delivered commit through failure finalization and a queued late collector", async () => {
    for (const mode of ["failure-commits", "failure-rejects", "delivery-commits"] as const) {
      const failureAppendRejects = mode === "failure-rejects";
      const deliveryCommitApplied = mode === "delivery-commits";
      const root = await mkdtemp(join(tmpdir(), `pi-email-main-commit-race-${mode}-`));
      const main = new FakeMainAdapter();
      const first = await setup(main, root);
      let restored: Awaited<ReturnType<typeof setup>> | undefined;
      try {
        const request = await first.broker.send(first.broker.mainAddress, {
          to: "worker.main-commit@gpt-5.4.com", subject: "Commit reply", message: "Reply once.", priority: "low",
        });
        const commitEntered = deferred();
        const releaseCommit = deferred();
        const realMarkDelivered = first.broker.mailStore.markDelivered.bind(first.broker.mailStore);
        let rejectCommit = true;
        first.broker.mailStore.markDelivered = async (ids) => {
          const targetsReply = ids.some((id) => first.broker.mailStore.get(id)?.kind === "reply");
          if (rejectCommit && targetsReply) {
            rejectCommit = false;
            commitEntered.resolve();
            await releaseCommit.promise;
            if (deliveryCommitApplied) await realMarkDelivered(ids);
            throw new Error("deterministic delivered journal commit rejection");
          }
          await realMarkDelivered(ids);
        };
        const realMarkFailed = first.broker.mailStore.markFailed.bind(first.broker.mailStore);
        let failedTransitions = 0;
        first.broker.mailStore.markFailed = async (id, error) => {
          failedTransitions += 1;
          if (failureAppendRejects) throw new Error("deterministic failure journal append rejection");
          await realMarkFailed(id, error);
        };

        const sending = first.workers[0]!.send({
          to: first.broker.mainAddress,
          subject: makeReplySubject(request.envelope.id, request.envelope.subject),
          message: "Presented before commit rejection.",
          priority: "low",
        });
        void sending.catch(() => undefined);
        await commitEntered.promise;
        const waiting = first.broker.waitForReplies([request.correlationId], 0, true);
        releaseCommit.resolve();
        const [sendOutcome, joined] = await Promise.all([sending.then(() => "fulfilled", () => "rejected"), waiting]);
        assert.equal(sendOutcome, "rejected");
        assert.equal(
          failedTransitions,
          deliveryCommitApplied ? 0 : 1,
          "the serialized route re-reads canonical delivery and the outer send path never repeats finalization",
        );
        assert.equal(main.deliveries.length, 1, "Pi presentation is accepted only once in the live race");
        assert.equal(joined.items[0]?.reply, undefined, "the late collector never duplicates the accepted presentation body");

        const reply = first.broker.mailStore.list().find((email) => email.inReplyTo === request.envelope.id);
        assert.ok(reply);
        const original = first.broker.mailStore.get(request.envelope.id);
        const failedAndOpen = reply.deliveryState === "failed"
          && original?.answeredBy === undefined
          && original?.replyReservedBy === undefined;
        const deliveredAndAnswered = reply.deliveryState === "delivered"
          && original?.answeredBy === reply.id
          && original?.replyReservedBy === undefined;
        assert.equal(failedAndOpen || deliveredAndAnswered, true);
        assert.equal(reply.deliveryState === "failed" && original?.answeredBy === reply.id, false);
        assert.equal(failureAppendRejects || deliveryCommitApplied ? deliveredAndAnswered : failedAndOpen, true);

        await first.broker.shutdown();
        restored = await setup(new FakeMainAdapter(), root);
        const reloadedReply = restored.broker.mailStore.get(reply.id);
        const reloadedOriginal = restored.broker.mailStore.get(request.envelope.id);
        assert.equal(reloadedReply?.deliveryState, reply.deliveryState);
        assert.equal(reloadedOriginal?.answeredBy, original?.answeredBy);
        assert.equal(reloadedOriginal?.replyReservedBy, undefined);
        assert.equal(reloadedReply?.deliveryState === "failed" && reloadedOriginal?.answeredBy === reply.id, false);
      } finally {
        await first.broker.shutdown().catch(() => undefined);
        await restored?.broker.shutdown().catch(() => undefined);
      }
    }
  });

  it("keeps settlement flushing coherent when its delivered commit rejects before a late collector", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main);
    try {
      const { request, reply } = await requestAndReply(broker, workers);
      const commitEntered = deferred();
      const releaseCommit = deferred();
      const realMarkDelivered = broker.mailStore.markDelivered.bind(broker.mailStore);
      let rejectCommit = true;
      broker.mailStore.markDelivered = async (ids) => {
        if (rejectCommit && ids.includes(reply.envelope.id)) {
          rejectCommit = false;
          commitEntered.resolve();
          await releaseCommit.promise;
          throw new Error("deterministic flush delivered commit rejection");
        }
        await realMarkDelivered(ids);
      };

      main.idle = true;
      const flushing = broker.flushQueuedMainMail();
      await commitEntered.promise;
      const waiting = broker.waitForReplies([request.correlationId], 0, true);
      releaseCommit.resolve();
      const [, joined] = await Promise.all([flushing, waiting]);
      assert.equal(main.deliveries.length, 1);
      assert.equal(joined.items[0]?.reply, undefined);
      assert.equal(broker.mailStore.get(reply.envelope.id)?.deliveryState, "failed");
      const original = broker.mailStore.get(request.envelope.id);
      assert.equal(original?.answeredBy, undefined);
      assert.equal(original?.replyReservedBy, undefined);
      assert.match(main.failures.at(-1) ?? "", /canonical state failed/i);
    } finally { await broker.shutdown(); }
  });

  it("routes a high reply accepted before a collector and omits its ordinarily presented body", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main);
    try {
      const first = await broker.send(broker.mainAddress, {
        to: "worker.main-preaccepted-high@gpt-5.4.com", subject: "Preaccepted high", message: "Reply high.", priority: "low",
      });
      const second = await broker.send(broker.mainAddress, {
        to: "reviewer.main-preaccepted-slow@gpt-5.4.com", subject: "Preaccepted slow", message: "Remain pending.", priority: "low",
      });
      const entered = deferred();
      const release = deferred();
      const reserveReply = broker.mailStore.reserveReply.bind(broker.mailStore);
      broker.mailStore.reserveReply = async (reply, originalId) => {
        await reserveReply(reply, originalId);
        entered.resolve();
        await release.promise;
      };
      const sending = workers[0]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(first.envelope.id, first.envelope.subject),
        message: "Preaccepted urgent body.",
        priority: "high",
      });
      await entered.promise;
      const waiting = broker.waitForReplies([first.correlationId, second.correlationId], 1_000, true);
      release.resolve();
      const [high, joined] = await Promise.all([sending, waiting]);
      assert.equal(joined.timedOut, false);
      assert.equal(joined.complete, false);
      assert.equal(joined.items.find((item) => item.requestId === first.correlationId)?.reply, undefined);
      assert.equal(joined.items.find((item) => item.requestId === second.correlationId)?.state, "pending");
      assert.deepEqual(main.deliveries.map((delivery) => delivery.envelope.id), [high.envelope.id]);
      const recovery = await broker.waitForReplies([first.correlationId], 0, true);
      assert.equal(recovery.items[0]?.reply?.message, "Preaccepted urgent body.");
    } finally { await broker.shutdown(); }
  });

  it("does not count transient queued high mail against the low main backlog limit", async () => {
    const main = new FakeMainAdapter();
    main.idle = false;
    const { broker, workers } = await setup(main, undefined, { maxQueuedMessages: 1 });
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.main-transient-high@gpt-5.4.com", subject: "Start", message: "Start.", priority: "low",
      });
      await broker.mailStore.accept({
        id: "mail_transient_high_capacity",
        from: "worker.main-transient-high@gpt-5.4.com",
        to: broker.mainAddress,
        subject: "Transient high",
        message: "urgent",
        priority: "high",
        kind: "request",
        requiresResponse: true,
        createdAt: new Date().toISOString(),
        deliveryState: "queued",
      });
      const low = await workers[0]!.send({
        to: broker.mainAddress, subject: "Bounded low", message: "ordinary", priority: "low",
      });
      assert.equal(low.envelope.deliveryState, "queued");
      assert.equal(broker.mailStore.queued(broker.mainAddress).filter((email) => email.priority === "low").length, 1);
    } finally { await broker.shutdown(); }
  });

  it("drains multiple queued lows in order across successive idle settlements", async () => {
    class BusyAfterDeliveryMain extends FakeMainAdapter {
      override async deliver(delivery: MainDelivery): Promise<void> {
        await super.deliver(delivery);
        this.idle = false;
      }
    }
    const main = new BusyAfterDeliveryMain();
    main.idle = false;
    const { broker, workers } = await setup(main, undefined, { maxQueuedMessages: 2 });
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.main-backlog@gpt-5.4.com", subject: "Start", message: "Start.", priority: "low",
      });
      const first = await workers[0]!.send({ to: broker.mainAddress, subject: "First", message: "one", priority: "low" });
      const second = await workers[0]!.send({ to: broker.mainAddress, subject: "Second", message: "two", priority: "low" });
      main.idle = true;
      await broker.flushQueuedMainMail();
      assert.deepEqual(main.deliveries.map((delivery) => delivery.envelope.id), [first.envelope.id]);
      main.idle = true;
      await broker.flushQueuedMainMail();
      assert.deepEqual(main.deliveries.map((delivery) => delivery.envelope.id), [first.envelope.id, second.envelope.id]);
    } finally { await broker.shutdown(); }
  });
});
