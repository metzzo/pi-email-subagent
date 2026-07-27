import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
    const first = await setup({ maxAgents: 2 });
    await first.broker.send(first.broker.mainAddress, {
      to: "worker.one@gpt-5.4.com", subject: "One", message: "One.", priority: "low",
    });
    await first.broker.send(first.broker.mainAddress, {
      to: "worker.two@gpt-5.4.com", subject: "Two", message: "Two.", priority: "low",
    });
    await first.broker.shutdown();

    const second = await setup({ maxAgents: 1 }, first.root);
    try {
      assert.equal(second.broker.getSnapshot().agents.length, 2);
      assert.equal(second.workers.length, 1);
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
      await eventually(() => assert.equal(broker.inspectAgent(request.envelope.to).state, "failed"));
      await assert.rejects(broker.clearFailure(request.envelope.to), /idle, stopped, or archived/);
      await broker.stop(request.envelope.to);
      await broker.clearFailure(request.envelope.to);
      assert.equal(broker.inspectAgent(request.envelope.to).failure, undefined);
    } finally {
      await broker.shutdown();
    }
  });

  it("holds a timing-out collector through an in-flight reply commit", async () => {
    const { broker, workers, main } = await setup();
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
      const waiting = broker.waitForReplies([request.envelope.id], 10, true).finally(() => { waitSettled = true; });
      const replying = workers[0]!.send({
        to: broker.mainAddress,
        subject: request.expectedReplySubject!,
        message: "Captured across timeout boundary.",
        priority: "low",
      });
      await enteredCommit.promise;
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(waitSettled, false, "timeout waits for the claimed delivery commit");
      releaseCommit.resolve();
      await replying;
      const result = await waiting;
      assert.equal(result.complete, true);
      assert.equal(result.timedOut, false);
      assert.equal(result.items[0]?.reply?.message, "Captured across timeout boundary.");
      assert.equal(main.deliveries.length, 0);
    } finally {
      await broker.shutdown();
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
      await assert.rejects(waiting, /aborted/);
      await workers[0]!.send({
        to: broker.mainAddress,
        subject: request.expectedReplySubject!,
        message: "Delivered normally after collector abort.",
        priority: "low",
      });
      assert.equal(main.deliveries.length, 1);
      assert.equal(main.deliveries[0]?.triggerTurn, true);
    } finally {
      await broker.shutdown();
    }
  });

  it("returns structured pending results when reply wait times out", async () => {
    const { broker } = await setup();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.timeout@gpt-5.4.com", subject: "Timeout", message: "Stay pending.", priority: "low",
      });
      const result = await broker.waitForReplies([request.envelope.id], 0, true);
      assert.equal(result.timedOut, true);
      assert.equal(result.complete, false);
      assert.equal(result.items[0]?.state, "pending");
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
});
