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
  private signalEntered!: () => void;
  private releaseDelivery!: () => void;

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
