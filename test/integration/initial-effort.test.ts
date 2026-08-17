import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { MailStore } from "../../src/mail-store.ts";
import type { SubagentConfig } from "../../src/types.ts";
import { FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

async function setup(root: string, configOverrides: Partial<SubagentConfig> = {}) {
  const workers: FakeWorker[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config, configOverrides);
  const broker = new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config,
    models: [fakeModel("gpt-5.6-sol")],
    mainAdapter: new FakeMainAdapter("main@gpt-5.6-sol.com"),
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    projectTrusted: true,
  });
  await broker.init();
  return { broker, workers };
}

describe("initial delegation effort", () => {
  it("previews and starts an unknown agent at the requested effort", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-initial-effort-"));
    const { broker, workers } = await setup(root);
    try {
      const prospective = broker.inspectAgent("worker.deep@gpt-5.6-sol.com", "xhigh");
      assert.equal(prospective.exists, false);
      assert.equal(prospective.effort, "xhigh");
      assert.equal(broker.getSnapshot().agents.length, 0, "inspection remains side-effect free");

      const sent = await broker.send(broker.mainAddress, {
        to: "worker.deep@gpt-5.6-sol.com",
        subject: "Deep task",
        message: "Start this identity with xhigh reasoning.",
        priority: "low",
        effort: "xhigh",
      });
      assert.equal(sent.spawned, true);
      assert.equal(sent.recipientEffort, "xhigh");
      assert.equal(sent.envelope.effortIntent, "xhigh");
      assert.equal(broker.inspectAgent(sent.envelope.to).effort, "xhigh");
      assert.equal(broker.getSnapshot().agents[0]?.effort, "xhigh");
      assert.equal(workers[0]?.record?.effort, "xhigh");
    } finally {
      await broker.shutdown();
    }
  });

  it("rejects effort mutation through later mail, existing inspection, replies, and main mail", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-initial-effort-reject-"));
    const { broker, workers } = await setup(root);
    try {
      const sent = await broker.send(broker.mainAddress, {
        to: "worker.fixed@gpt-5.6-sol.com",
        subject: "Fixed effort",
        message: "Persist the initial effort.",
        priority: "low",
        effort: "xhigh",
      });
      await assert.rejects(
        broker.send(broker.mainAddress, {
          to: sent.envelope.to,
          subject: "Mutate effort",
          message: "Do not change an existing identity through mail.",
          priority: "low",
          effort: "high",
        }),
        /effort overrides are accepted only on the first delegation.*already exists/i,
      );
      assert.throws(
        () => broker.inspectAgent(sent.envelope.to, "high"),
        /effort override.*prospective unknown agent/i,
      );
      await assert.rejects(
        workers[0]!.send({
          to: broker.mainAddress,
          subject: "Main effort",
          message: "Effort does not apply to main mail.",
          priority: "low",
          effort: "xhigh",
        }),
        /effort overrides apply only when creating an unknown subagent/i,
      );
      await assert.rejects(
        broker.send(broker.mainAddress, {
          to: "worker.invalid@gpt-5.6-sol.com",
          subject: "Invalid effort",
          message: "Direct broker callers are validated too.",
          priority: "low",
          effort: "ultra" as never,
        }),
        /effort must be one of/i,
      );

      await workers[0]!.send({
        to: broker.mainAddress,
        subject: `Re: [${sent.envelope.id}] ${sent.envelope.subject}`,
        message: "Done.",
        priority: "low",
      });
      assert.equal(broker.inspectAgent(sent.envelope.to).effort, "xhigh");
    } finally {
      await broker.shutdown();
    }
  });

  it("recovers requested effort from durable spawn intent without a registry record", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-effort-intent-"));
    const store = new MailStore(join(root, "state", "mail.jsonl"));
    await store.init();
    await store.accept({
      id: "mail_effort_intent",
      from: "main@gpt-5.6-sol.com",
      to: "worker.recover@gpt-5.6-sol.com",
      subject: "Recover effort",
      message: "Recover the exact accepted effort.",
      priority: "low",
      kind: "request",
      requiresResponse: true,
      createdAt: new Date().toISOString(),
      deliveryState: "queued",
      effortIntent: "xhigh",
    });

    const { broker, workers } = await setup(root);
    try {
      assert.equal(broker.inspectAgent("worker.recover@gpt-5.6-sol.com").effort, "xhigh");
      assert.equal(workers[0]?.record?.effort, "xhigh");
    } finally {
      await broker.shutdown();
    }
  });
});
