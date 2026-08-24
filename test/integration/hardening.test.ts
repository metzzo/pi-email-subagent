import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { MailStore } from "../../src/mail-store.ts";
import { makeReplySubject } from "../../src/reply.ts";
import type { MainDelivery, SubagentConfig } from "../../src/types.ts";
import { createWorkerFactory, eventually, FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

async function setup(overrides: Partial<SubagentConfig> = {}, namespace?: string, main = new FakeMainAdapter()) {
  const root = namespace ?? await mkdtemp(join(tmpdir(), "pi-email-hardening-"));
  const workers: FakeWorker[] = [];
  const broker = new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config: { ...structuredClone(DEFAULT_CONFIG), ...overrides },
    models: [fakeModel("gpt-5.4")],
    mainAdapter: main,
    workerFactory: createWorkerFactory(workers),
    projectTrusted: true,
  });
  await broker.init();
  return { root, broker, workers, main };
}

async function answerAndSettle(broker: AgentBroker, worker: FakeWorker, request: { id: string; subject: string }) {
  await worker.send({
    to: broker.mainAddress,
    subject: makeReplySubject(request.id, request.subject),
    message: "Completed.",
    priority: "low",
  });
  worker.settle();
  await eventually(() => assert.equal(broker.inspectAgent(worker.record!.address).state, "idle"));
}

describe("broker hardening", () => {
  it("enforces one live broker per persistent namespace", async () => {
    const first = await setup();
    try {
      await assert.rejects(setup({}, first.root), /namespace is already owned.*pid/i);
    } finally {
      await first.broker.shutdown();
    }
    const replacement = await setup({}, first.root);
    await replacement.broker.shutdown();
  });

  it("redelivers queued main mail during crash recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-main-restore-"));
    const store = new MailStore(join(root, "state", "mail.jsonl"));
    await store.init();
    await store.accept({
      id: "mail_restore_main",
      from: "worker.restore@gpt-5.4.com",
      to: "main@gpt-5.4.com",
      subject: "Restore main mail",
      message: "Redeliver after crash.",
      priority: "low",
      kind: "request",
      requiresResponse: true,
      createdAt: new Date().toISOString(),
      deliveryState: "queued",
    });
    const original = {
      id: "mail_restore_original",
      from: "main@gpt-5.4.com",
      to: "worker.reply-restore@gpt-5.4.com",
      subject: "Restore reserved reply",
      message: "Reply before crash.",
      priority: "low" as const,
      kind: "request" as const,
      requiresResponse: true,
      createdAt: new Date().toISOString(),
      deliveryState: "queued" as const,
    };
    await store.accept(original);
    await store.markDelivered([original.id]);
    await store.reserveReply({
      id: "mail_restore_reply",
      from: original.to,
      to: original.from,
      subject: makeReplySubject(original.id, original.subject),
      message: "Reserved reply survives crash.",
      priority: "low",
      kind: "reply",
      inReplyTo: original.id,
      requiresResponse: false,
      createdAt: new Date().toISOString(),
      deliveryState: "queued",
    }, original.id);
    const restored = await setup({}, root);
    try {
      assert.equal(restored.main.deliveries.length, 2);
      assert.deepEqual(restored.main.deliveries.map((delivery) => delivery.envelope.id), ["mail_restore_main", "mail_restore_reply"]);
      assert.equal(restored.broker.mailStore.get("mail_restore_main")?.deliveryState, "delivered");
      assert.equal(restored.broker.mailStore.get(original.id)?.answeredBy, "mail_restore_reply");
    } finally {
      await restored.broker.shutdown();
    }
  });

  it("reconstructs a missing recipient record from accepted queued mail after a crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-orphan-restore-"));
    const store = new MailStore(join(root, "state", "mail.jsonl"));
    await store.init();
    await store.accept({
      id: "mail_orphaned_recipient",
      from: "main@gpt-5.4.com",
      to: "worker.orphaned@gpt-5.4.com",
      subject: "Recover recipient",
      message: "Accepted before the process crashed.",
      priority: "low",
      kind: "request",
      requiresResponse: true,
      createdAt: new Date().toISOString(),
      deliveryState: "queued",
    });

    const restored = await setup({}, root);
    try {
      assert.equal(restored.workers.length, 1);
      await eventually(() => assert.match(restored.workers[0]!.prompts[0]!, /mail_orphaned_recipient/));
      assert.equal(restored.broker.mailStore.get("mail_orphaned_recipient")?.deliveryState, "delivered");
      assert.equal(restored.broker.inspectAgent("worker.orphaned@gpt-5.4.com").exists, true);
    } finally {
      await restored.broker.shutdown();
    }
  });

  it("permits only one concurrent reply and reopens after main delivery failure", async () => {
    class FailingMain extends FakeMainAdapter {
      fail = false;
      override async deliver(delivery: MainDelivery): Promise<void> {
        if (this.fail) throw new Error("main unavailable");
        await super.deliver(delivery);
      }
    }
    const main = new FailingMain();
    const { broker, workers } = await setup({}, undefined, main);
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.reply-race@gpt-5.4.com", subject: "Reply once", message: "Do work.", priority: "low",
      });
      const worker = workers[0]!;
      const subject = makeReplySubject(request.envelope.id, request.envelope.subject);
      const attempts = await Promise.allSettled([
        worker.send({ to: broker.mainAddress, subject, message: "First.", priority: "low" }),
        worker.send({ to: broker.mainAddress, subject, message: "Second.", priority: "low" }),
      ]);
      assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    } finally {
      await broker.shutdown();
    }

    const retryMain = new FailingMain();
    const second = await setup({}, undefined, retryMain);
    try {
      const request = await second.broker.send(second.broker.mainAddress, {
        to: "worker.failed-reply@gpt-5.4.com", subject: "Retry reply", message: "Do work.", priority: "low",
      });
      const worker = second.workers[0]!;
      retryMain.fail = true;
      await assert.rejects(worker.send({
        to: second.broker.mainAddress,
        subject: makeReplySubject(request.envelope.id, request.envelope.subject),
        message: "Delivery will fail.",
        priority: "low",
      }), /main unavailable/);
      assert.deepEqual(worker.fetch().map((email) => email.id), [request.envelope.id]);
      retryMain.fail = false;
      await worker.send({
        to: second.broker.mainAddress,
        subject: makeReplySubject(request.envelope.id, request.envelope.subject),
        message: "Retry succeeds.",
        priority: "low",
      });
      assert.deepEqual(worker.fetch(), []);
    } finally {
      await second.broker.shutdown();
    }
  });

  it("accepts ordinary mail for a failed identity without routing or implicit restart", async () => {
    const { broker, workers } = await setup();
    try {
      const initial = await broker.send(broker.mainAddress, {
        to: "worker.failed-queued@gpt-5.4.com", subject: "Initial", message: "Answer before failure.", priority: "low",
      });
      await workers[0]!.send({
        to: broker.mainAddress,
        subject: initial.expectedReplySubject!,
        message: "Initial request complete.",
        priority: "low",
      });
      workers[0]!.settle();
      await eventually(() => assert.equal(broker.inspectAgent(initial.envelope.to).state, "idle"));
      workers[0]!.fail("terminal provider failure");
      await eventually(() => assert.equal(broker.inspectAgent(initial.envelope.to).state, "failed"));

      const firstQueued = await broker.send(broker.mainAddress, {
        to: initial.envelope.to, subject: "Queued one", message: "Preserve this accepted ID.", priority: "low",
      });
      const secondQueued = await broker.send(broker.mainAddress, {
        to: initial.envelope.to, subject: "Queued two", message: "Preserve this accepted ID too.", priority: "high",
      });
      for (const queued of [firstQueued, secondQueued]) {
        assert.equal(queued.spawned, false);
        assert.equal(queued.recipientDisposition, "failed");
        assert.equal(queued.recipientState, "failed");
        assert.equal(queued.envelope.deliveryState, "queued");
      }
      assert.equal(workers.length, 1, "ordinary accepted mail never creates a replacement worker");

      await broker.restart(initial.envelope.to);
      assert.equal(workers.length, 2, "only explicit restart creates the replacement worker");
      await eventually(() => assert.equal(workers[1]!.prompts.length, 1));
      assert.match(workers[1]!.prompts[0]!, new RegExp(firstQueued.envelope.id));
      assert.match(workers[1]!.prompts[0]!, new RegExp(secondQueued.envelope.id));
      assert.equal(broker.mailStore.get(firstQueued.envelope.id)?.deliveryState, "delivered");
      assert.equal(broker.mailStore.get(secondQueued.envelope.id)?.deliveryState, "delivered");
    } finally {
      await broker.shutdown();
    }
  });

  it("checks failed state before an attached worker and keeps the accepted envelope queued", async () => {
    const { broker, workers } = await setup();
    try {
      const initial = await broker.send(broker.mainAddress, {
        to: "worker.failed-attached@gpt-5.4.com", subject: "Initial", message: "Remain attached.", priority: "low",
      });
      workers[0]!.emit({ type: "state", state: "failed" });
      assert.equal(broker.inspectAgent(initial.envelope.to).state, "failed");

      const queued = await broker.send(broker.mainAddress, {
        to: initial.envelope.to, subject: "Must queue", message: "Do not route to the attached worker.", priority: "high",
      });
      assert.equal(queued.recipientDisposition, "failed");
      assert.equal(queued.envelope.deliveryState, "queued");
      assert.equal(workers[0]!.steers.length, 0);
      assert.equal(workers.length, 1);
    } finally {
      await broker.shutdown();
    }
  });

  it("queues a child reply for a failed parent without answering until explicit parent restart", async () => {
    const { broker, workers } = await setup();
    try {
      const upstream = await broker.send(broker.mainAddress, {
        to: "worker.failed-parent@gpt-5.4.com", subject: "Parent", message: "Delegate once.", priority: "low",
      });
      const childRequest = await workers[0]!.send({
        to: "worker.failed-child@gpt-5.4.com", subject: "Child", message: "Return a child result.", priority: "low",
      });
      workers[0]!.fail("parent failed before child reply");
      await eventually(() => assert.equal(broker.inspectAgent(upstream.envelope.to).state, "failed"));

      const childReply = await workers[1]!.send({
        to: upstream.envelope.to,
        subject: childRequest.expectedReplySubject!,
        message: "Durable child result.",
        priority: "low",
      });
      assert.equal(childReply.recipientDisposition, "failed");
      assert.equal(childReply.envelope.deliveryState, "queued");
      assert.equal(broker.mailStore.get(childRequest.envelope.id)?.replyReservedBy, childReply.envelope.id);
      assert.equal(broker.mailStore.get(childRequest.envelope.id)?.answeredAt, undefined);
      assert.equal(workers.length, 2);
    } finally {
      await broker.shutdown();
    }
  });

  it("accepts mail for a known failed binding that is absent from the current catalog", async () => {
    const first = await setup();
    await first.broker.send(first.broker.mainAddress, {
      to: "worker.removed-failed@gpt-5.4.com", subject: "Persist", message: "Persist the identity.", priority: "low",
    });
    first.workers[0]!.fail("terminal before model removal");
    await eventually(() => assert.equal(first.broker.inspectAgent("worker.removed-failed@gpt-5.4.com").state, "failed"));
    await first.broker.shutdown();

    const registryPath = join(first.root, "state", "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as { agents: Array<Record<string, unknown>> };
    registry.agents[0]!.provider = "removed-provider";
    registry.agents[0]!.modelId = "gpt-5.4";
    registry.agents[0]!.state = "failed";
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const restored = await setup({}, first.root);
    try {
      const accepted = await restored.broker.send(restored.broker.mainAddress, {
        to: "worker.removed-failed@gpt-5.4.com", subject: "Queue while unavailable", message: "Do not consult the catalog.", priority: "low",
      });
      assert.equal(accepted.recipientDisposition, "failed");
      assert.equal(accepted.envelope.deliveryState, "queued");
      assert.equal(accepted.spawned, false);
      assert.equal(restored.workers.length, 0);
      await assert.rejects(restored.broker.restart(accepted.envelope.to), /removed-provider\/gpt-5\.4.*not rebound/i);
      assert.equal(restored.broker.mailStore.get(accepted.envelope.id)?.deliveryState, "queued");
    } finally {
      await restored.broker.shutdown();
    }
  });

  it("re-enforces the original sender when a queued agent-to-agent reply later fails delivery", async () => {
    const { broker, workers } = await setup();
    try {
      const mainRequest = await broker.send(broker.mainAddress, {
        to: "worker.sender@gpt-5.4.com", subject: "Parent work", message: "Coordinate child.", priority: "low",
      });
      const sender = workers[0]!;
      const childRequest = await sender.send({
        to: "worker.responder@gpt-5.4.com", subject: "Child work", message: "Reply to sender.", priority: "low",
      });
      const responder = workers[1]!;
      await responder.send({
        to: sender.record!.address,
        subject: makeReplySubject(childRequest.envelope.id, childRequest.envelope.subject),
        message: "This queued reply will fail delivery.",
        priority: "low",
      });
      responder.settle();
      await eventually(() => assert.equal(broker.inspectAgent(responder.record!.address).state, "idle"));
      await sender.send({
        to: broker.mainAddress,
        subject: makeReplySubject(mainRequest.envelope.id, mainRequest.envelope.subject),
        message: "Parent obligation complete.",
        priority: "low",
      });
      sender.prompt = async () => { throw new Error("queued prompt rejected"); };
      sender.settle();

      await eventually(() => {
        assert.equal(responder.prompts.length, 2);
        assert.match(responder.prompts[1]!, /mailbox-enforcement/);
      });
      assert.equal(responder.fetch().some((email) => email.id === childRequest.envelope.id), true);
    } finally {
      await broker.shutdown();
    }
  });

  it("prioritizes high mail across agents and bounds a busy recipient queue", async () => {
    const { broker, workers } = await setup({ maxConcurrent: 1, maxQueuedMessages: 1 });
    try {
      const first = await broker.send(broker.mainAddress, {
        to: "worker.first@gpt-5.4.com", subject: "First", message: "Hold slot.", priority: "low",
      });
      await broker.send(broker.mainAddress, {
        to: "worker.low@gpt-5.4.com", subject: "Low", message: "Wait.", priority: "low",
      });
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "worker.low@gpt-5.4.com", subject: "Overflow", message: "Too much.", priority: "low",
      }), /queue.*full/i);
      await broker.send(broker.mainAddress, {
        to: "worker.high@gpt-5.4.com", subject: "High", message: "Go next.", priority: "high",
      });
      await answerAndSettle(broker, workers[0]!, { id: first.envelope.id, subject: first.envelope.subject });
      await eventually(() => assert.equal(workers[2]!.prompts.length, 1));
      assert.equal(workers[1]!.prompts.length, 0);
    } finally {
      await broker.shutdown();
    }
  });

  it("enforces queue capacity atomically across parallel sends", async () => {
    const { broker, workers } = await setup({ maxQueuedMessages: 1 });
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.parallel-cap@gpt-5.4.com", subject: "Start", message: "Keep running.", priority: "low",
      });
      assert.equal(workers[0]?.streaming, true);
      const attempts = await Promise.allSettled([
        broker.send(broker.mainAddress, {
          to: "worker.parallel-cap@gpt-5.4.com", subject: "One", message: "Queued one.", priority: "low",
        }),
        broker.send(broker.mainAddress, {
          to: "worker.parallel-cap@gpt-5.4.com", subject: "Two", message: "Queued two.", priority: "low",
        }),
      ]);
      assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
      assert.equal(broker.mailStore.queued("worker.parallel-cap@gpt-5.4.com").length, 1);
    } finally {
      await broker.shutdown();
    }
  });

  it("bounds formatted delivery bytes for queued and immediate high mail", async () => {
    const { broker, workers } = await setup({ maxBatchBytes: 420 });
    try {
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "worker.formatted@gpt-5.4.com", subject: "Expanded", message: "&".repeat(100), priority: "low",
      }), /formatted email exceeds/i);
      assert.equal(workers.length, 0);
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "worker.formatted@gpt-5.4.com",
        subject: "Too many lines",
        message: Array.from({ length: 2_000 }, () => "x").join("\n"),
        priority: "low",
      }), /context-safe envelope limit/);
      assert.equal(workers.length, 0);

      await broker.send(broker.mainAddress, {
        to: "worker.formatted@gpt-5.4.com", subject: "Small", message: "small", priority: "low",
      });
      assert.equal(workers[0]?.streaming, true);
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "worker.formatted@gpt-5.4.com", subject: "High expanded", message: "&".repeat(100), priority: "high",
      }), /formatted email exceeds/i);
      assert.equal(workers[0]?.steers.length, 0);
    } finally {
      await broker.shutdown();
    }
  });

  it("caps a single envelope independently from a larger delivery-batch budget", async () => {
    const { broker, workers } = await setup({ maxBatchBytes: 512 * 1024 });
    try {
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "worker.context-safe@gpt-5.4.com",
        subject: "Escaped expansion",
        message: "&".repeat(10_000),
        priority: "low",
      }), /context-safe envelope limit/);
      assert.equal(workers.length, 0);
    } finally {
      await broker.shutdown();
    }
  });

  it("pages fetch_emails by configured batch limits without hiding the total", async () => {
    const { broker, workers } = await setup({ maxBatchMessages: 1 });
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.fetch-page@gpt-5.4.com", subject: "One", message: "First.", priority: "low",
      });
      await broker.send(broker.mainAddress, {
        to: "worker.fetch-page@gpt-5.4.com", subject: "Two", message: "Second.", priority: "high",
      });
      const batch = workers[0]!.config!.fetchEmails();
      assert.equal(batch.total, 2);
      assert.equal(batch.emails.length, 1);
      assert.equal(batch.emails[0]?.subject, "Two");
    } finally {
      await broker.shutdown();
    }
  });

  it("does not charge invalid mail against sender quota", async () => {
    const { broker } = await setup({ maxMailsPerMinute: 2, maxMailsPerSenderPerMinute: 1 });
    try {
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "invalid", subject: "Bad", message: "Bad.", priority: "low",
      }));
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "worker.valid@gpt-5.4.com", subject: "Bad\nInjected: header", message: "Bad.", priority: "low",
      }), /line breaks or control characters/);
      await broker.send(broker.mainAddress, {
        to: "worker.valid@gpt-5.4.com", subject: "Valid", message: "Accepted.", priority: "low",
      });
    } finally {
      await broker.shutdown();
    }
  });

  it("preserves overflow identities when maxAgents is lowered", async () => {
    const first = await setup({ maxAgents: 2, maxConcurrent: 2 });
    await first.broker.send(first.broker.mainAddress, {
      to: "worker.one@gpt-5.4.com", subject: "One", message: "One.", priority: "low",
    });
    await first.broker.send(first.broker.mainAddress, {
      to: "worker.two@gpt-5.4.com", subject: "Two", message: "Two.", priority: "low",
    });
    await first.broker.shutdown();

    const second = await setup({ maxAgents: 1, maxConcurrent: 1 }, first.root);
    try {
      const snapshot = second.broker.getSnapshot();
      assert.equal(snapshot.agents.length, 2);
      assert.deepEqual(snapshot.capacity, {
        identitiesUsed: 1, identitiesLimit: 1, runSlotsUsed: 1, runSlotsLimit: 1,
      });
      assert.equal(second.workers.length, 1);
      assert.equal(second.broker.inspectAgent("worker.one@gpt-5.4.com").holdsActivationLease, true);
      assert.equal(second.broker.inspectAgent("worker.two@gpt-5.4.com").holdsActivationLease, false);
      assert.equal(second.broker.inspectAgent("worker.two@gpt-5.4.com").capacityAvailable, false);
      assert.match(second.broker.inspectAgent("worker.two@gpt-5.4.com").currentActivity ?? "", /Paused by maxAgents capacity/);
      await assert.rejects(second.broker.send(second.broker.mainAddress, {
        to: "worker.two@gpt-5.4.com", subject: "Activate overflow", message: "Must remain paused.", priority: "low",
      }), /Agent limit reached/);
      assert.equal(second.workers.length, 1);
      await assert.rejects(second.broker.send(second.broker.mainAddress, {
        to: "worker.three@gpt-5.4.com", subject: "Three", message: "Three.", priority: "low",
      }), /Agent limit reached/);
    } finally {
      await second.broker.shutdown();
    }
  });

  it("previews without spawning, enriches send results, joins replies, and archives clean identities", async () => {
    const { broker, workers, main } = await setup({ maxAgents: 1 });
    try {
      const preview = broker.inspectAgent("worker.tools@gpt-5.4.com");
      assert.equal(preview.exists, false);
      assert.equal(preview.wouldSpawn, true);
      assert.equal(preview.writable, true);
      assert.equal(workers.length, 0);
      assert.equal(broker.getSnapshot().agents.length, 0);

      const request = await broker.send(broker.mainAddress, {
        to: preview.address, subject: "Use tools", message: "Return result.", priority: "low",
      });
      assert.equal(request.correlationId, request.envelope.id);
      assert.equal(request.expectedReplySubject, makeReplySubject(request.envelope.id, request.envelope.subject));
      assert.equal(request.recipientRole, "worker");
      assert.equal(request.recipientTools?.includes("write"), true);

      const waiting = broker.waitForReplies([request.envelope.id], 2_000, true);
      const secondWaiter = broker.waitForReplies([request.envelope.id], 2_000, true);
      await workers[0]!.send({
        to: broker.mainAddress,
        subject: request.expectedReplySubject!,
        message: "Joined result.",
        priority: "low",
      });
      const [joined, joinedAgain] = await Promise.all([waiting, secondWaiter]);
      assert.equal(joined.complete, true);
      assert.equal(joinedAgain.complete, true);
      assert.equal(joined.items[0]?.reply?.message, "Joined result.");
      assert.equal(main.deliveries.length, 0, "collected replies are rendered by the wait tool, not injected as a second turn");
      workers[0]!.settle();
      await eventually(() => assert.equal(broker.inspectAgent(preview.address).state, "idle"));

      await broker.archive(preview.address);
      assert.equal(broker.inspectAgent(preview.address).state, "archived");
      const restored = await broker.send(broker.mainAddress, {
        to: preview.address, subject: "Restore context", message: "Resume the archived identity.", priority: "low",
      });
      assert.equal(restored.recipientDisposition, "restored");
      assert.equal(restored.spawned, false);
      await answerAndSettle(broker, workers[1]!, { id: restored.envelope.id, subject: restored.envelope.subject });
      await broker.archive(preview.address);

      const replacement = await broker.send(broker.mainAddress, {
        to: "worker.replacement@gpt-5.4.com", subject: "Replacement", message: "Capacity freed.", priority: "low",
      });
      assert.equal(replacement.spawned, true);
      await assert.rejects(broker.restart(preview.address), /Agent limit reached/);
    } finally {
      await broker.shutdown();
    }
  });

  it("rejects archival while an agent has an outstanding request it sent", async () => {
    const { broker, workers } = await setup();
    try {
      const parent = await broker.send(broker.mainAddress, {
        to: "worker.outbound-owner@gpt-5.4.com", subject: "Parent", message: "Delegate child.", priority: "low",
      });
      const owner = workers[0]!;
      await owner.send({
        to: "worker.outbound-peer@gpt-5.4.com", subject: "Outstanding child", message: "Do not reply yet.", priority: "low",
      });
      await owner.send({
        to: broker.mainAddress,
        subject: makeReplySubject(parent.envelope.id, parent.envelope.subject),
        message: "Parent done while child remains open.",
        priority: "low",
      });
      owner.settle();
      await eventually(() => assert.equal(broker.inspectAgent(owner.record!.address).state, "idle"));
      await assert.rejects(broker.archive(owner.record!.address), /queued mail or unanswered obligations/);
    } finally {
      await broker.shutdown();
    }
  });

  it("clears only a stopped agent's stale failure diagnostic", async () => {
    const { broker, workers } = await setup();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.clear-failure@gpt-5.4.com", subject: "Fail", message: "Simulate failure.", priority: "low",
      });
      workers[0]!.fail("provider unavailable");
      await eventually(() => {
        const inspection = broker.inspectAgent(request.envelope.to);
        assert.equal(inspection.state, "failed");
        assert.equal(inspection.cleanup, undefined);
        assert.equal(workers[0]?.disposed, true, "provider-failure worker disposal completed");
        assert.equal((broker as any).cleanupQuarantines.has(request.envelope.to), false, "broker cleanup lease release completed before lifecycle assertions");
      });
      await assert.rejects(broker.clearFailure(request.envelope.to), /idle, stopped, or archived/);
      await broker.stop(request.envelope.to);
      await broker.clearFailure(request.envelope.to);
      assert.equal(broker.inspectAgent(request.envelope.to).failure, undefined);
    } finally {
      await broker.shutdown();
    }
  });

  it("holds a timing-out collector through an in-flight reply commit", async () => {
    const { broker, workers, main } = await setup({
      // Keep the test bounded without making ordinary concurrent CI filesystem
      // scheduling compete with an unrealistically small production deadline.
      lifecycle: { ...structuredClone(DEFAULT_CONFIG.lifecycle), brokerShutdownTimeoutMs: 2_000 },
    });
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.timeout-race@gpt-5.4.com", subject: "Timeout race", message: "Reply during slow journal I/O.", priority: "low",
      });
      const enteredCommit = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        return { promise, resolve };
      })();
      const releaseCommit = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        return { promise, resolve };
      })();
      const realMarkDelivered = broker.mailStore.markDelivered.bind(broker.mailStore);
      broker.mailStore.markDelivered = async (ids) => {
        enteredCommit.resolve();
        await releaseCommit.promise;
        await realMarkDelivered(ids);
      };

      let waitSettled = false;
      // Leave enough pre-claim time for journal reservation even when the full
      // cross-file suite is busy, so this assertion exercises timeout during
      // the gated delivery commit rather than scheduler latency before claim.
      const waiting = broker.waitForReplies([request.envelope.id], 5_000, true).finally(() => { waitSettled = true; });
      const replying = workers[0]!.send({
        to: broker.mainAddress,
        subject: request.expectedReplySubject!,
        message: "Captured across timeout boundary.",
        priority: "low",
      });
      await enteredCommit.promise;
      await new Promise((resolve) => setTimeout(resolve, 5_025));
      assert.equal(waitSettled, false, "timeout waits for the claimed delivery commit");
      releaseCommit.resolve();
      await replying;
      const result = await waiting;
      broker.mailStore.markDelivered = realMarkDelivered;
      assert.equal(result.complete, true);
      assert.equal(result.timedOut, false);
      assert.equal(result.items[0]?.reply?.message, "Captured across timeout boundary.");
      assert.equal(main.deliveries.length, 0);
      assert.equal((broker as unknown as { collectingRequestIds: Map<string, number> }).collectingRequestIds.size, 0);
      assert.equal((broker as unknown as { collectionClaims: Map<string, number> }).collectionClaims.size, 0);
      assert.equal((broker as unknown as { addressTails: Map<string, unknown> }).addressTails.size, 0, "collector leaves no address tail");
      assert.equal((broker as unknown as { inFlightOperations: Set<unknown> }).inFlightOperations.size, 0, "collector leaves no tracked mutation");
    } finally {
      const shutdownStarted = Date.now();
      await broker.shutdown();
      assert.ok(Date.now() - shutdownStarted < 4_000, "collector race leaves no stale shutdown barrier");
    }
  });

  it("cleans up an aborted reply collector and resumes normal main delivery", async () => {
    const { broker, workers, main } = await setup();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.abort-wait@gpt-5.4.com", subject: "Abort wait", message: "Reply after abort.", priority: "low",
      });
      const controller = new AbortController();
      const waiting = broker.waitForReplies([request.envelope.id], 2_000, true, controller.signal);
      controller.abort();
      const partial = await waiting;
      assert.equal(partial.complete, false);
      assert.equal(partial.timedOut, false);
      assert.equal(partial.items[0]?.state, "pending");
      await workers[0]!.send({
        to: broker.mainAddress,
        subject: request.expectedReplySubject!,
        message: "Delivered normally after collector abort.",
        priority: "low",
      });
      assert.equal(main.deliveries.length, 1);
      assert.equal(main.deliveries[0]?.envelope.kind, "reply");
      assert.equal(main.deliveries[0]?.envelope.inReplyTo, request.envelope.id);
      assert.equal(main.deliveries[0]?.triggerTurn, true);
      assert.equal(broker.mailStore.get(request.envelope.id)?.answeredBy, main.deliveries[0]?.envelope.id);
      assert.equal((broker as unknown as { collectingRequestIds: Map<string, number> }).collectingRequestIds.size, 0);
      assert.equal((broker as unknown as { collectionClaims: Map<string, number> }).collectionClaims.size, 0);
    } finally {
      await broker.shutdown();
    }
  });

  it("releases a timed-out collector without losing or duplicating a later correlated reply", async () => {
    const { root, broker, workers, main } = await setup();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.timeout@gpt-5.4.com", subject: "Timeout", message: "Reply after the wait.", priority: "low",
      });
      const result = await broker.waitForReplies([request.envelope.id], 0, true);
      assert.equal(result.timedOut, true);
      assert.equal(result.complete, false);
      assert.equal(result.items[0]?.requestId, request.envelope.id);
      assert.equal(result.items[0]?.state, "pending");
      assert.equal((broker as unknown as { collectingRequestIds: Map<string, number> }).collectingRequestIds.has(request.envelope.id), false);
      assert.equal((broker as unknown as { collectionClaims: Map<string, number> }).collectionClaims.has(request.envelope.id), false);
      assert.equal((broker as unknown as { changeListeners: Set<unknown> }).changeListeners.size, 0);

      const reply = await workers[0]!.send({
        to: broker.mainAddress,
        subject: request.expectedReplySubject!,
        message: "Delivered after the timed-out collector released.",
        priority: "low",
      });
      assert.equal(reply.answeredEmailId, request.envelope.id);
      assert.equal(main.deliveries.length, 1);
      assert.equal(main.deliveries[0]?.envelope.kind, "reply");
      assert.equal(main.deliveries[0]?.envelope.inReplyTo, request.envelope.id);
      assert.equal(main.deliveries[0]?.triggerTurn, true);
      assert.equal(broker.mailStore.get(request.envelope.id)?.answeredBy, reply.envelope.id);
      assert.equal(broker.mailStore.list().filter((email) => email.kind === "reply" && email.inReplyTo === request.envelope.id).length, 1);

      const journal = (await readFile(join(root, "state", "mail.jsonl"), "utf8"))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; id?: string; replyId?: string });
      assert.equal(journal.filter((event) => event.type === "email.answered"
        && event.id === request.envelope.id && event.replyId === reply.envelope.id).length, 1);
      assert.equal((broker as unknown as { collectingRequestIds: Map<string, number> }).collectingRequestIds.size, 0);
      assert.equal((broker as unknown as { collectionClaims: Map<string, number> }).collectionClaims.size, 0);
    } finally {
      await broker.shutdown();
    }
  });

  it("accepts replies to maximally sized subjects", async () => {
    const { broker, workers } = await setup({ maxSubjectBytes: 64 });
    try {
      const subject = "S".repeat(64);
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.limit@gpt-5.4.com", subject, message: "Task.", priority: "low",
      });
      const replySubject = makeReplySubject(sent.envelope.id, subject);
      assert.ok(Buffer.byteLength(replySubject, "utf8") > 64);
      const reply = await workers[0]!.send({
        to: broker.mainAddress, subject: replySubject, message: "Done.", priority: "low",
      });
      assert.equal(reply.answeredEmailId, sent.envelope.id);
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "worker.limit@gpt-5.4.com", subject: "N".repeat(65), message: "Too long.", priority: "low",
      }), /Subject exceeds 64 bytes/);
      await assert.rejects(workers[0]!.send({
        to: broker.mainAddress, subject: `${replySubject}${"R".repeat(64)}`, message: "Too long.", priority: "low",
      }), /Subject exceeds 128 bytes/);
    } finally {
      await broker.shutdown();
    }
  });

  it("reports capacity-paused recipients as terminal in reply waits", async () => {
    const first = await setup({ maxAgents: 2 });
    await first.broker.send(first.broker.mainAddress, {
      to: "worker.one@gpt-5.4.com", subject: "One", message: "One.", priority: "low",
    });
    const pending = await first.broker.send(first.broker.mainAddress, {
      to: "worker.two@gpt-5.4.com", subject: "Two", message: "Two.", priority: "low",
    });
    await first.broker.shutdown();

    const second = await setup({ maxAgents: 1 }, first.root);
    try {
      assert.equal(second.broker.inspectAgent("worker.two@gpt-5.4.com").state, "paused");
      const result = await second.broker.waitForReplies([pending.envelope.id], 0, true);
      assert.equal(result.complete, true);
      assert.equal(result.timedOut, false);
      assert.equal(result.items[0]?.state, "paused");
      assert.match(result.items[0]?.error ?? "", /paused/i);
    } finally {
      await second.broker.shutdown();
    }
  });

  it("quarantines stale-model records without blocking valid restoration", async () => {
    const first = await setup();
    await first.broker.send(first.broker.mainAddress, {
      to: "worker.valid-restore@gpt-5.4.com", subject: "Valid", message: "Persist me.", priority: "low",
    });
    await first.broker.shutdown();

    const registryPath = join(first.root, "state", "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as { agents: Array<Record<string, unknown>> };
    const stale = structuredClone(registry.agents[0]!);
    stale.address = "worker.stale-restore@removed-model.com";
    stale.modelId = "removed-model";
    stale.provider = "removed-provider";
    stale.state = "paused";
    registry.agents.push(stale);
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const restored = await setup({}, first.root);
    try {
      assert.equal(restored.workers.length, 1, "valid record still restores");
      const staleInspection = restored.broker.inspectAgent("worker.stale-restore@removed-model.com");
      assert.equal(staleInspection.state, "failed");
      assert.equal(staleInspection.provider, "removed-provider");
      assert.match(staleInspection.failure ?? "", /model unavailable/i);
      await assert.rejects(restored.broker.restart(staleInspection.address), /bound to removed-provider\/removed-model.*not rebound/is);
      assert.equal(restored.broker.inspectAgent(staleInspection.address).state, "failed");
      await restored.broker.archive(staleInspection.address);
      assert.equal(restored.broker.inspectAgent(staleInspection.address).state, "archived");
    } finally {
      await restored.broker.shutdown();
    }
  });

  it("does not report failed-delivery mail as an open obligation", async () => {
    const { broker } = await setup({ maxBatchBytes: 300 });
    try {
      await assert.rejects(broker.send(broker.mainAddress, {
        to: "worker.failed-count@gpt-5.4.com", subject: "Too large", message: "&".repeat(100), priority: "low",
      }), /formatted email exceeds/i);
      // Pre-acceptance rejection creates no record or mail; now exercise a persisted delivery failure.
      const result = await broker.send(broker.mainAddress, {
        to: "worker.failed-count@gpt-5.4.com", subject: "Start", message: "small", priority: "low",
      });
      await broker.mailStore.markFailed(result.envelope.id, "forced terminal failure");
      assert.equal(broker.inspectAgent(result.envelope.to).unanswered, 0);
    } finally {
      await broker.shutdown();
    }
  });

  it("drains maintenance added immediately before shutdown without bookkeeping cycles", async () => {
    const { broker } = await setup({
      lifecycle: { ...structuredClone(DEFAULT_CONFIG.lifecycle), brokerShutdownTimeoutMs: 400 },
    });
    let release!: () => void;
    const held = new Promise<boolean>((resolve) => { release = () => resolve(false); });
    broker.mailStore.maintainIfNeeded = async () => held;
    await broker.send(broker.mainAddress, {
      to: "worker.maintenance-shutdown@gpt-5.4.com",
      subject: "Maintain at shutdown",
      message: "Create a tracked maintenance mutation.",
      priority: "low",
    });
    let closed = false;
    const closing = broker.shutdown().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(closed, false, "shutdown waits for the real maintenance mutation");
    release();
    await closing;
  });

  it("schedules journal maintenance during a live broker session", async () => {
    const { broker } = await setup();
    const original = broker.mailStore.maintainIfNeeded.bind(broker.mailStore);
    let calls = 0;
    broker.mailStore.maintainIfNeeded = async (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.maintenance@gpt-5.4.com", subject: "Maintain", message: "Trigger maintenance.", priority: "low",
      });
      await eventually(() => assert.ok(calls > 0));
    } finally {
      await broker.shutdown();
    }
  });

  it("treats canSpawn as subagent delegation permission for known and unknown identities", async () => {
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.scout!.canSpawn = false;
    roles.worker!.canSpawn = true;
    const { broker, workers, main } = await setup({ roles });
    try {
      const scoutOne = await broker.send(broker.mainAddress, {
        to: "scout.one@gpt-5.4.com", subject: "One", message: "First.", priority: "low",
      });
      await broker.send(broker.mainAddress, {
        to: "scout.two@gpt-5.4.com", subject: "Two", message: "Second.", priority: "low",
      });
      assert.equal(workers.length, 2);

      await assert.rejects(workers[0]!.send({
        to: "scout.two@gpt-5.4.com", subject: "Known delegation", message: "Existing identity.", priority: "low",
      }), /not permitted to delegate to subagents/);
      await assert.rejects(workers[0]!.send({
        to: "scout.three@gpt-5.4.com", subject: "Unknown delegation", message: "New identity.", priority: "low",
      }), /not permitted to delegate to subagents/);
      assert.equal(workers.length, 2, "disabled delegation creates no worker or envelope");

      const exactReply = await workers[0]!.send({
        to: broker.mainAddress,
        subject: scoutOne.expectedReplySubject!,
        message: "Exact replies remain permitted.",
        priority: "low",
      });
      assert.equal(exactReply.answeredEmailId, scoutOne.envelope.id);
      const mainMail = await workers[0]!.send({
        to: broker.mainAddress,
        subject: "Non-delegation status",
        message: "Ordinary mail to main remains permitted.",
        priority: "low",
      });
      assert.equal(mainMail.recipientDisposition, "main");
      assert.equal(main.deliveries.length, 2);

      await broker.send(broker.mainAddress, {
        to: "worker.three@gpt-5.4.com", subject: "Three", message: "Explicitly opted in.", priority: "low",
      });
      const spawned = await workers[2]!.send({
        to: "scout.four@gpt-5.4.com", subject: "Four", message: "Fourth.", priority: "low",
      });
      assert.equal(spawned.spawned, true);
    } finally {
      await broker.shutdown();
    }
  });

  it("disables delegation for unknown roles by default", async () => {
    const { broker, workers } = await setup();
    try {
      await broker.send(broker.mainAddress, {
        to: "analyst.parent@gpt-5.4.com", subject: "Parent", message: "Do not fan out.", priority: "low",
      });
      await assert.rejects(workers[0]!.send({
        to: "analyst.child@gpt-5.4.com", subject: "Child", message: "Must be rejected.", priority: "low",
      }), /not permitted to delegate to subagents/);
      assert.equal(workers.length, 1);
    } finally {
      await broker.shutdown();
    }
  });

  it("marks requests delivered before the worker run observes its mailbox", async () => {
    // A fast worker can read its mailbox during the first moments of a run,
    // before a post-acceptance markDelivered would land; delivery must be
    // journaled before prompt acceptance and before steering.
    class EagerWorker extends FakeWorker {
      mailboxAtPrompt: number[] = [];
      mailboxAtSteer: number[] = [];
      override async prompt(message: string): Promise<void> {
        await super.prompt(message);
        this.mailboxAtPrompt.push(this.fetch().length);
      }
      override async steer(message: string): Promise<void> {
        this.mailboxAtSteer.push(this.fetch().length);
        await super.steer(message);
      }
    }
    const root = await mkdtemp(join(tmpdir(), "pi-email-hardening-"));
    const workers: EagerWorker[] = [];
    const broker = new AgentBroker({
      cwd: root,
      agentDir: root,
      namespaceDir: join(root, "state"),
      config: structuredClone(DEFAULT_CONFIG),
      models: [fakeModel("gpt-5.4")],
      mainAdapter: new FakeMainAdapter(),
      workerFactory: () => {
        const worker = new EagerWorker();
        workers.push(worker);
        return worker;
      },
      projectTrusted: true,
    });
    await broker.init();
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.eager@gpt-5.4.com", subject: "Eager", message: "Read your mailbox immediately.", priority: "low",
      });
      assert.deepEqual(workers[0]!.mailboxAtPrompt, [1]);

      // The fake worker stays streaming; a high-priority request is steered
      // and must already be visible in the worker mailbox at steer time.
      await broker.send(broker.mainAddress, {
        to: "worker.eager@gpt-5.4.com", subject: "Urgent", message: "Steered while busy.", priority: "high",
      });
      assert.deepEqual(workers[0]!.mailboxAtSteer, [2]);
    } finally {
      await broker.shutdown();
    }
  });
});
