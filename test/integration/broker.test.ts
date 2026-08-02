import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentBroker, lightweightWorkItem } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { makeReplySubject } from "../../src/reply.ts";
import type { SubagentConfig } from "../../src/types.ts";
import { createWorkerFactory, eventually, FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";
import { activePathConflicts, appendRecent, emptyWorkState, finishWorkItem, startWorkItem } from "../../src/work-ledger.ts";

async function setup(overrides: Partial<SubagentConfig> = {}, namespace?: string) {
  const root = namespace ?? await mkdtemp(join(tmpdir(), "pi-email-broker-"));
  const workers: FakeWorker[] = [];
  const main = new FakeMainAdapter();
  const config: SubagentConfig = { ...structuredClone(DEFAULT_CONFIG), ...overrides };
  const broker = new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config,
    models: [fakeModel("gpt-5.4"), fakeModel("kimi-for-coding", "kimi-coding")],
    mainAdapter: main,
    workerFactory: createWorkerFactory(workers),
    projectTrusted: true,
  });
  await broker.init();
  return { broker, workers, main, root };
}

describe("AgentBroker end-to-end routing", () => {
  it("projects lightweight work without traversing patch preview bytes", () => {
    const item = startWorkItem("edit", "edit", { path: "a", edits: [] }, 1, "/work")!;
    Object.defineProperty(item, "patchPreview", { enumerable: true, get() { throw new Error("preview traversed"); } });
    const projected = lightweightWorkItem(item);
    assert.equal(projected.patchAvailable, true);
    assert.equal(Object.prototype.hasOwnProperty.call(projected, "patchPreview"), false);
  });

  it("publishes deterministic same-path active conflict evidence for two agents", async () => {
    const { broker, workers, root } = await setup();
    try {
      for (const to of ["worker.left@gpt-5.4.com", "worker.right@gpt-5.4.com"]) await broker.send(broker.mainAddress, { to, subject: "edit", message: "edit same", priority: "low" });
      for (let index = 0; index < workers.length; index++) {
        const worker = workers[index]!; worker.record!.work = emptyWorkState(); worker.record!.work.currentBatchId = 1;
        const item = startWorkItem(`edit${index}`, "edit", { path: "same.ts", edits: [] }, 1, root)!;
        worker.record!.work.active.push(item); worker.emit({ type: "work", workItem: item });
      }
      assert.equal(activePathConflicts(broker.getSnapshot().agents).values().next().value?.length, 2);
    } finally { await broker.shutdown(); }
  });

  it("debounces parallel completion saves while persisting the final work generation", async () => {
    const { broker, workers } = await setup();
    try {
      await broker.send(broker.mainAddress, { to: "worker.persist-work@gpt-5.4.com", subject: "work", message: "work", priority: "low" });
      const worker = workers[0]!; worker.record!.work = emptyWorkState(); worker.record!.work.currentBatchId = 1;
      let saves = 0; const original = broker.registryStore.save.bind(broker.registryStore);
      broker.registryStore.save = async (registry) => { saves += 1; await original(registry); };
      for (let index = 0; index < 8; index++) {
        const item = finishWorkItem(startWorkItem(`w${index}`, "write", { path: `f${index}`, content: "x" }, 1, "/work")!, {}, false);
        appendRecent(worker.record!.work, item); worker.emit({ type: "work", workItem: item });
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.ok(saves <= 2, `expected coalesced saves, got ${saves}`);
      const stored = await broker.registryStore.load(broker.mainAddress);
      assert.equal(stored.agents[0]!.work!.recent.length, 8);
    } finally { await broker.shutdown(); }
  });

  it("recovers durable mutation results for a stopped identity without worker startup", async () => {
    const first = await setup();
    await first.broker.send(first.broker.mainAddress, { to: "worker.offline@gpt-5.4.com", subject: "offline", message: "offline", priority: "low" });
    await first.broker.stop("worker.offline@gpt-5.4.com"); await first.broker.shutdown();
    const manager = SessionManager.create(first.root, join(first.root, "state", "sessions"));
    const at = new Date().toISOString(); manager.appendCustomEntry("pi-email-subagent-work-batch", { batchId: 1, startedAt: at });
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "offline-edit", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } }], timestamp: Date.now(), provider: "test", model: "test", api: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" } as never);
    manager.appendMessage({ role: "toolResult", toolCallId: "offline-edit", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { patch: "@@ -1 +1 @@\n-x\n+y" }, isError: false, timestamp: Date.now() } as never);
    const registry = await first.broker.registryStore.load(first.broker.mainAddress); registry.agents[0]!.sessionFile = manager.getSessionFile(); registry.agents[0]!.work = emptyWorkState(); await first.broker.registryStore.save(registry);
    const second = await setup({}, first.root);
    try {
      assert.equal(second.workers.length, 0);
      const recovered = second.broker.getSnapshot().agents[0]!.work!.recent.find((item) => item.toolCallId === "offline-edit");
      assert.equal(recovered?.status, "succeeded");
    } finally { await second.broker.shutdown(); }
  });

  it("spawns once, reuses context, steers high mail, and queues low mail", async () => {
    const { broker, workers } = await setup();
    try {
      const first = await broker.send(broker.mainAddress, {
        to: "reviewer.audit-auth@gpt-5.4.com",
        subject: "Audit auth",
        message: "Inspect auth.",
        priority: "low",
      });
      assert.equal(first.spawned, true);
      assert.equal(workers.length, 1);
      assert.equal(workers[0]!.prompts.length, 1);
      assert.match(workers[0]!.prompts[0]!, /Audit auth/);

      const low = await broker.send(broker.mainAddress, {
        to: "reviewer.audit-auth@gpt-5.4.com",
        subject: "Also inspect tests",
        message: "Review tests after current work.",
        priority: "low",
      });
      assert.equal(low.spawned, false);
      assert.equal(low.envelope.deliveryState, "queued");
      assert.equal(workers[0]!.prompts.length, 1);

      const high = await broker.send(broker.mainAddress, {
        to: "reviewer.audit-auth@gpt-5.4.com",
        subject: "Critical correction",
        message: "Use the new token path.",
        priority: "high",
      });
      assert.equal(high.envelope.deliveryState, "delivered");
      assert.equal(workers[0]!.steers.length, 1);
      assert.match(workers[0]!.steers[0]!, /Critical correction/);
    } finally {
      await broker.shutdown();
    }
  });

  it("tracks exact substantive reply obligations without acknowledgement loops", async () => {
    const { broker, workers, main } = await setup();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.fix-parser@gpt-5.4.com",
        subject: "Fix parser",
        message: "Inspect and fix it.",
        priority: "low",
      });
      const worker = workers[0]!;
      assert.deepEqual(worker.fetch().map((email) => email.id), [request.envelope.id]);

      const response = await worker.send({
        to: broker.mainAddress,
        subject: makeReplySubject(request.envelope.id, request.envelope.subject),
        message: "Fixed parser.ts and tests pass.",
        priority: "low",
      });
      assert.equal(response.answeredEmailId, request.envelope.id);
      assert.deepEqual(worker.fetch(), []);
      assert.equal(main.deliveries.length, 1);
      assert.equal(main.deliveries[0]!.envelope.kind, "reply");
      assert.deepEqual(broker.fetchUnanswered(broker.mainAddress), []);

      await assert.rejects(
        worker.send({
          to: broker.mainAddress,
          subject: makeReplySubject(request.envelope.id, request.envelope.subject),
          message: "Duplicate.",
          priority: "low",
        }),
        /already answered/,
      );
      worker.settle("This final text must not create a duplicate reply.");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(main.deliveries.length, 1);
    } finally {
      await broker.shutdown();
    }
  });

  it("mechanically emails the visible final answer when the worker omits send_email", async () => {
    const { broker, workers, main } = await setup({ responseReminderLimit: 2 });
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.completion-fallback@gpt-5.4.com",
        subject: "Return result",
        message: "Finish the work and report it.",
        priority: "low",
      });
      const waiting = broker.waitForReplies([request.envelope.id], 2_000, true);
      const worker = workers[0]!;
      worker.settle("Implemented parser.ts and all tests pass.");
      const result = await waiting;
      assert.equal(result.complete, true);
      assert.equal(result.items[0]?.state, "answered");
      assert.equal(result.items[0]?.reply?.message, "Implemented parser.ts and all tests pass.");
      assert.equal(worker.prompts.length, 1, "mechanical completion avoids a reminder model turn");
      assert.equal(main.deliveries.length, 0, "the active collector receives the reply directly");
    } finally {
      await broker.shutdown();
    }
  });

  it("UTF-8 safely bounds an automatic completion email", async () => {
    const { broker, workers } = await setup({ maxMessageBytes: 128 });
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.bounded-completion@gpt-5.4.com",
        subject: "Bound result",
        message: "Return a bounded result.",
        priority: "low",
      });
      const waiting = broker.waitForReplies([request.envelope.id], 2_000, true);
      workers[0]!.settle("🙂".repeat(100));
      const result = await waiting;
      const message = result.items[0]?.reply?.message ?? "";
      assert.ok(Buffer.byteLength(message, "utf8") <= 128);
      assert.match(message, /Automatic completion email truncated/);
      assert.doesNotMatch(message, /�/);
    } finally {
      await broker.shutdown();
    }
  });

  it("automatically follows up twice, then escalates a truly silent worker", async () => {
    const { broker, workers, main } = await setup({ responseReminderLimit: 2 });
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.forgetful@gpt-5.4.com",
        subject: "Must answer",
        message: "Return a result.",
        priority: "low",
      });
      const worker = workers[0]!;
      worker.settle();
      await eventually(() => assert.equal(worker.prompts.length, 2));
      assert.match(worker.prompts[1]!, /mailbox-enforcement/);

      worker.settle();
      await eventually(() => assert.equal(worker.prompts.length, 3));
      assert.match(worker.prompts[2]!, /level="final"/);

      worker.settle();
      await eventually(() => {
        assert.equal(broker.getSnapshot().agents[0]!.state, "failed");
        assert.equal(main.failures.length, 1);
      });
      assert.match(main.failures[0]!, /unanswered email/);
    } finally {
      await broker.shutdown();
    }
  });

  it("surfaces terminal worker errors without issuing misleading mailbox reminders", async () => {
    const { broker, workers, main } = await setup({ responseReminderLimit: 2 });
    try {
      await broker.send(broker.mainAddress, {
        to: "worker.provider-error@gpt-5.4.com",
        subject: "Run provider request",
        message: "Return a result.",
        priority: "low",
      });
      const worker = workers[0]!;
      worker.fail('404 {"error":{"type":"resource_not_found_error"}}');
      await eventually(() => {
        const record = broker.getSnapshot().agents[0]!;
        assert.equal(record.state, "failed");
        assert.match(record.failure ?? "", /resource_not_found_error/);
        assert.equal(main.failures.length, 1);
      });

      worker.settle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(worker.prompts.length, 1);
      assert.equal(broker.getSnapshot().agents[0]!.state, "failed");
      assert.match(main.failures[0]!, /resource_not_found_error/);
      assert.doesNotMatch(main.failures[0]!, /unanswered email/);
    } finally {
      await broker.shutdown();
    }
  });

  it("enforces active concurrency while accepting work immediately", async () => {
    const { broker, workers } = await setup({ maxConcurrent: 1 });
    try {
      const first = await broker.send(broker.mainAddress, {
        to: "worker.first@gpt-5.4.com",
        subject: "First",
        message: "Do first task.",
        priority: "low",
      });
      const second = await broker.send(broker.mainAddress, {
        to: "worker.second@kimi-for-coding.com",
        subject: "Second",
        message: "Do second task.",
        priority: "low",
      });
      assert.equal(workers.length, 2);
      assert.equal(workers[0]!.prompts.length, 1);
      assert.equal(workers[1]!.prompts.length, 0);
      assert.equal(second.envelope.deliveryState, "queued");
      assert.equal(broker.getSnapshot().agents.find((agent) => agent.address.includes("second"))?.state, "queued");

      await workers[0]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(first.envelope.id, first.envelope.subject),
        message: "First complete.",
        priority: "low",
      });
      workers[0]!.settle();
      await eventually(() => assert.equal(workers[1]!.prompts.length, 1));
      assert.match(workers[1]!.prompts[0]!, /Second/);
    } finally {
      await broker.shutdown();
    }
  });

  it("routes replies to an old main alias after a model change", async () => {
    const { broker, workers, main } = await setup();
    try {
      const oldMain = broker.mainAddress;
      const request = await broker.send(oldMain, {
        to: "scout.alias-test@gpt-5.4.com",
        subject: "Check aliases",
        message: "Reply after main changes model.",
        priority: "low",
      });
      main.address = "main@kimi-for-coding.com";
      main.aliases.add(main.address);
      await broker.updateMainAddress(main.address);

      await workers[0]!.send({
        to: oldMain,
        subject: makeReplySubject(request.envelope.id, request.envelope.subject),
        message: "Old alias still works.",
        priority: "low",
      });
      assert.equal(main.deliveries.at(-1)?.envelope.to, oldMain);
      assert.equal(broker.getSnapshot().mainAddress, "main@kimi-for-coding.com");
    } finally {
      await broker.shutdown();
    }
  });

  it("restores persistent identities without duplicate spawning", async () => {
    const firstRun = await setup();
    const request = await firstRun.broker.send(firstRun.broker.mainAddress, {
      to: "worker.persist@gpt-5.4.com",
      subject: "Persist",
      message: "Complete before restart.",
      priority: "low",
    });
    await firstRun.workers[0]!.send({
      to: firstRun.broker.mainAddress,
      subject: makeReplySubject(request.envelope.id, request.envelope.subject),
      message: "Done.",
      priority: "low",
    });
    firstRun.workers[0]!.settle();
    await eventually(() => assert.equal(firstRun.broker.getSnapshot().agents[0]!.state, "idle"));
    await firstRun.broker.shutdown();

    const secondRun = await setup({}, firstRun.root);
    try {
      assert.equal(secondRun.workers.length, 1);
      assert.equal(secondRun.broker.getSnapshot().agents.length, 1);
      const next = await secondRun.broker.send(secondRun.broker.mainAddress, {
        to: "worker.persist@gpt-5.4.com",
        subject: "Continue",
        message: "Use the same context.",
        priority: "low",
      });
      assert.equal(next.spawned, false);
      assert.equal(secondRun.workers.length, 1);
      assert.equal(secondRun.workers[0]!.prompts.length, 1);
    } finally {
      await secondRun.broker.shutdown();
    }
  });

  it("enforces the agent cap before accepting an unknown recipient", async () => {
    const { broker } = await setup({ maxAgents: 1 });
    try {
      await broker.send(broker.mainAddress, {
        to: "scout.first@gpt-5.4.com",
        subject: "First",
        message: "First.",
        priority: "low",
      });
      await assert.rejects(
        broker.send(broker.mainAddress, {
          to: "scout.second@gpt-5.4.com",
          subject: "Second",
          message: "Second.",
          priority: "low",
        }),
        /Agent limit reached/,
      );
      assert.equal(broker.mailStore.list().length, 1);
    } finally {
      await broker.shutdown();
    }
  });

  it("rejects invalid recipients and foreign reply IDs before changing obligations", async () => {
    const { broker, workers } = await setup();
    try {
      await assert.rejects(
        broker.send(broker.mainAddress, { to: "bad-address", subject: "Bad", message: "Bad.", priority: "low" }),
        /exactly one|must end|local parts/,
      );
      assert.equal(broker.mailStore.list().length, 0);

      const first = await broker.send(broker.mainAddress, {
        to: "worker.first@gpt-5.4.com",
        subject: "Private request",
        message: "Only first can answer.",
        priority: "low",
      });
      await broker.send(broker.mainAddress, {
        to: "worker.second@gpt-5.4.com",
        subject: "Second request",
        message: "Independent.",
        priority: "low",
      });
      await assert.rejects(
        workers[1]!.send({
          to: broker.mainAddress,
          subject: makeReplySubject(first.envelope.id, first.envelope.subject),
          message: "Trying to close another worker's request.",
          priority: "low",
        }),
        /does not belong/,
      );
      assert.equal(workers[0]!.fetch().length, 1);
    } finally {
      await broker.shutdown();
    }
  });

  it("audit-cancels an abandoned request only after its recipient is inactive", async () => {
    const { broker, workers } = await setup();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "reviewer.retired@gpt-5.4.com",
        subject: "Review abandoned scope",
        message: "This work may be abandoned by the owner.",
        priority: "low",
      });
      assert.equal(broker.getSnapshot().unanswered, 1);
      await assert.rejects(broker.cancelRequest(request.correlationId, "short"), /at least 8/);
      await assert.rejects(broker.cancelRequest(request.correlationId, "🙂".repeat(300)), /1024 UTF-8 bytes/);
      const pendingReply = {
        ...request.envelope,
        id: "mail_pending_cancellation_race",
        from: request.envelope.to,
        to: request.envelope.from,
        subject: makeReplySubject(request.envelope.id, request.envelope.subject),
        message: "Reply whose delivery has not committed.",
        kind: "reply" as const,
        inReplyTo: request.envelope.id,
        requiresResponse: false,
        deliveryState: "queued" as const,
      };
      await broker.mailStore.reserveReply(pendingReply, request.envelope.id);
      assert.equal(broker.getSnapshot().unanswered, 0, "a reply reservation is not still labelled unanswered");
      assert.equal(broker.inspectAgent(request.envelope.to).unanswered, 0);
      assert.equal(broker.inspectAgent(request.envelope.to).pendingReplies, 1);
      await assert.rejects(broker.cancelRequest(request.correlationId, "Cannot beat a reply reservation."), /pending delivery/);
      await broker.mailStore.markFailed(pendingReply.id, "Simulated reply delivery rollback.");
      assert.equal(broker.getSnapshot().unanswered, 1);

      await assert.rejects(
        broker.cancelRequest(request.correlationId, "Owner abandoned this review."),
        /inactive recipient|stop the agent/i,
      );

      await broker.stop(request.envelope.to);
      const cancelled = await broker.cancelRequest(request.correlationId, "Owner abandoned this review after a scope violation.");
      assert.equal(cancelled.deliveryState, "cancelled");
      assert.equal(cancelled.cancelledBy, broker.mainAddress);
      assert.equal(cancelled.cancellationReason, "Owner abandoned this review after a scope violation.");
      assert.equal(cancelled.answeredAt, undefined, "administrative cancellation is not a fabricated reply");
      assert.equal(broker.getSnapshot().unanswered, 0);
      assert.equal(broker.inspectAgent(request.envelope.to).unanswered, 0);
      assert.deepEqual(broker.fetchUnanswered(request.envelope.to), []);

      const joined = await broker.waitForReplies([request.correlationId], 0, true);
      assert.equal(joined.complete, true);
      assert.equal(joined.items[0]?.state, "cancelled");
      assert.match(joined.items[0]?.error ?? "", /scope violation/);
      await assert.rejects(
        workers[0]!.send({
          to: broker.mainAddress,
          subject: makeReplySubject(request.envelope.id, request.envelope.subject),
          message: "Late fabricated result.",
          priority: "low",
        }),
        /has not been delivered|cancel/i,
      );

      await broker.cancelRequest(request.correlationId, "Idempotent retry uses the original durable reason.");
      assert.equal(broker.mailStore.get(request.correlationId)?.cancellationReason, "Owner abandoned this review after a scope violation.");
      await broker.archive(request.envelope.to);
      assert.equal(broker.inspectAgent(request.envelope.to).state, "archived");
    } finally {
      await broker.shutdown();
    }
  });

  it("supports idle effort changes plus stop and restart controls", async () => {
    const { broker, workers } = await setup();
    try {
      const request = await broker.send(broker.mainAddress, {
        to: "worker.controls@gpt-5.4.com",
        subject: "Control test",
        message: "Answer, then become idle.",
        priority: "low",
      });
      await assert.rejects(broker.setEffort("worker.controls@gpt-5.4.com", "high"), /idle/);
      await workers[0]!.send({
        to: broker.mainAddress,
        subject: makeReplySubject(request.envelope.id, request.envelope.subject),
        message: "Control test complete.",
        priority: "low",
      });
      workers[0]!.settle();
      await eventually(() => assert.equal(broker.getSnapshot().agents[0]!.state, "idle"));
      await broker.setEffort("worker.controls@gpt-5.4.com", "high");
      assert.equal(broker.getSnapshot().agents[0]!.effort, "high");

      await broker.stop("worker.controls@gpt-5.4.com");
      assert.equal(broker.getSnapshot().agents[0]!.state, "stopped");
      await broker.restart("worker.controls@gpt-5.4.com");
      assert.equal(workers.length, 2);
      assert.equal(broker.getSnapshot().agents[0]!.state, "idle");
    } finally {
      await broker.shutdown();
    }
  });
});
