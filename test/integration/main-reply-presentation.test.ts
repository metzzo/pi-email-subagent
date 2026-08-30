import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { makeReplySubject } from "../../src/reply.ts";
import type { MainDelivery } from "../../src/types.ts";
import { createWorkerFactory, FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

async function setup(main = new FakeMainAdapter(), root?: string) {
  const namespace = root ?? await mkdtemp(join(tmpdir(), "pi-email-main-presentation-"));
  const workers: FakeWorker[] = [];
  const broker = new AgentBroker({
    cwd: namespace,
    agentDir: namespace,
    namespaceDir: join(namespace, "state"),
    config: structuredClone(DEFAULT_CONFIG),
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

      assert.equal(joined.items[0]?.reply?.id, reply.envelope.id);
      assert.deepEqual(main.deliveries.map((delivery) => delivery.envelope.id), [reply.envelope.id]);
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
});
