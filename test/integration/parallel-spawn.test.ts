import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { createWorkerFactory, FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

it("singleflights concurrent sends to one unknown address", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-race-"));
  const workers: FakeWorker[] = [];
  const main = new FakeMainAdapter();
  const broker = new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config: structuredClone(DEFAULT_CONFIG),
    models: [fakeModel()],
    mainAdapter: main,
    workerFactory: createWorkerFactory(workers),
    projectTrusted: true,
  });
  await broker.init();
  try {
    const results = await Promise.all([
      broker.send(broker.mainAddress, {
        to: "scout.race@gpt-5.4.com",
        subject: "Race one",
        message: "First concurrent request.",
        priority: "low",
      }),
      broker.send(broker.mainAddress, {
        to: "scout.race@gpt-5.4.com",
        subject: "Race two",
        message: "Second concurrent request.",
        priority: "low",
      }),
    ]);
    assert.equal(workers.length, 1);
    assert.equal(results.filter((result) => result.spawned).length, 1);
    assert.equal(broker.getSnapshot().agents.length, 1);
    assert.equal(workers[0]!.prompts.length, 1);
    assert.match(workers[0]!.prompts[0]!, /agent-email-batch count="2"/);
  } finally {
    await broker.shutdown();
  }
});
