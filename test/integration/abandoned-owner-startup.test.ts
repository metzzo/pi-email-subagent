import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { kernelProcessIdentity } from "../../src/namespace-lock.ts";
import { FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

const ADDRESS = "worker.dead-owner@gpt-5.4.com";

function brokerAt(root: string, workers: FakeWorker[]) {
  return new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config: structuredClone(DEFAULT_CONFIG),
    models: [fakeModel("gpt-5.4")],
    mainAdapter: new FakeMainAdapter(),
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    projectTrusted: true,
  });
}

it("automatically reclaims an exact dead owner, preserves queued mail/session, and requires explicit restart", {
  skip: process.platform !== "linux" ? "exact owner fencing requires Linux /proc" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-dead-owner-startup-"));
  const initialWorkers: FakeWorker[] = [];
  const first = brokerAt(root, initialWorkers);
  await first.init();
  const initial = await first.send(first.mainAddress, {
    to: ADDRESS,
    subject: "Initial durable request",
    message: "Preserve this obligation.",
    priority: "low",
  });
  await first.stop(ADDRESS);
  const queued = await first.send(first.mainAddress, {
    to: ADDRESS,
    subject: "Queued across dead-owner reclaim",
    message: "Deliver only after explicit restart.",
    priority: "low",
  });
  assert.equal(queued.envelope.deliveryState, "queued");
  await first.shutdown();

  const namespaceDir = join(root, "state");
  const registryPath = join(namespaceDir, "registry.json");
  const sessionFile = join(namespaceDir, "sessions", "preserved-session.jsonl");
  await mkdir(join(namespaceDir, "sessions"), { recursive: true });
  await writeFile(sessionFile, "{}\n");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as any;
  const record = registry.agents.find((candidate: any) => candidate.address === ADDRESS);
  const at = "2026-09-01T00:00:00.000Z";
  record.state = "failed";
  record.sessionFile = sessionFile;
  record.workerEpoch = {
    generation: 9,
    phase: "activated",
    tools: ["bash", "send_email", "fetch_emails"],
    mutationCapable: true,
    runSlotHeld: false,
  };
  record.cleanup = {
    state: "unknown",
    reasonCode: "WORKER_CLEANUP_REPORT_UNKNOWN",
    workerGeneration: 9,
    startedAt: at,
    updatedAt: at,
    abort: "succeeded",
    dispose: "succeeded",
    quiescence: "unknown",
    mutationCapableAtStart: true,
    heldRunSlot: false,
    activeTools: [],
    detail: "Legacy completed Bash lacked an OS-process receipt.",
  };
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  const identity = await kernelProcessIdentity(process.pid);
  await writeFile(join(namespaceDir, ".broker-owner.json"), `${JSON.stringify({
    pid: 999_999_999,
    token: "exact-dead-owner",
    acquiredAt: at,
    namespaceDir,
    bootId: identity.bootId,
    processStartTime: "1",
  }, null, 2)}\n`);
  await mkdir(`${namespaceDir}.lock`);

  const restoredWorkers: FakeWorker[] = [];
  const restored = brokerAt(root, restoredWorkers);
  await restored.init();
  try {
    const inspection = restored.inspectAgent(ADDRESS);
    assert.equal(inspection.state, "failed");
    assert.equal(inspection.cleanup, undefined);
    assert.equal(restoredWorkers.length, 0, "dead-owner normalization never auto-restores a worker");
    const persisted = JSON.parse(await readFile(registryPath, "utf8")) as any;
    const migrated = persisted.agents.find((candidate: any) => candidate.address === ADDRESS);
    assert.equal(migrated.workerEpoch.phase, "session-settled");
    assert.equal(migrated.workerEpoch.runSlotHeld, false);
    assert.equal(migrated.sessionFile, sessionFile);
    assert.match(migrated.failure, /historical cleanup generation 9.*no OS-process proof.*explicit same-identity restart/i);
    assert.equal(restored.mailStore.get(initial.envelope.id)?.deliveryState, "delivered");
    assert.equal(restored.mailStore.get(queued.envelope.id)?.deliveryState, "queued");

    await restored.restart(ADDRESS);
    assert.equal(restoredWorkers.length, 1, "one explicit restart creates the next same-identity session");
    assert.equal(restored.inspectAgent(ADDRESS).cleanup, undefined);
  } finally {
    await restored.shutdown().catch(() => undefined);
  }
});
