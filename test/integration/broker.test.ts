import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { makeReplySubject } from "../../src/reply.ts";
import type { SubagentConfig } from "../../src/types.ts";
import { createWorkerFactory, eventually, FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

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
    } finally {
      await broker.shutdown();
    }
  });

  it("automatically follows up twice, then escalates unanswered mail", async () => {
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
