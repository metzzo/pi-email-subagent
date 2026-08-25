import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { executeCleanupRecoveryCommand } from "../../src/cleanup-recovery.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { createMainCoordinationTools } from "../../src/main-tools.ts";
import { makeReplySubject } from "../../src/reply.ts";
import type { AgentRecord } from "../../src/types.ts";
import { FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

const ADDRESS = "worker.operator-release@gpt-5.4.com";
const EVIDENCE = "Operator verified the exact external worker generation is quiescent.";

async function brokerAt(root: string, workers: FakeWorker[] = []): Promise<AgentBroker> {
  const broker = new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config: structuredClone(DEFAULT_CONFIG),
    models: [fakeModel("gpt-5.4")],
    mainAdapter: new FakeMainAdapter(),
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    projectTrusted: true,
  });
  await broker.init();
  return broker;
}

async function waitForDelivery(broker: AgentBroker, id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (broker.mailStore.get(id)?.deliveryState === "delivered") return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
  }
  assert.fail(`mail ${id} was not delivered after explicit restart`);
}

async function seedPersistedUnknown(root: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const first = await brokerAt(root);
  const original = await first.send(first.mainAddress, { to: ADDRESS, subject: "Original", message: "Create the durable identity.", priority: "low" });
  await first.stop(ADDRESS);
  await first.cancelRequest(original.envelope.id, "Fixture closes the identity-creation request.");
  await first.shutdown();
  const path = join(root, "state", "registry.json");
  const registry = JSON.parse(await readFile(path, "utf8")) as any;
  const record = registry.agents.find((candidate: any) => candidate.address === ADDRESS);
  const now = new Date().toISOString();
  record.state = "failed";
  record.failure = "Cleanup quarantine: externally reviewed.";
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
    startedAt: now,
    updatedAt: now,
    abort: "succeeded",
    dispose: "succeeded",
    quiescence: "unknown",
    mutationCapableAtStart: true,
    heldRunSlot: false,
    activeTools: [],
    ...overrides,
  };
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`);
}

function storedRecord(root: string): Promise<AgentRecord> {
  return readFile(join(root, "state", "registry.json"), "utf8").then((value) => {
    const registry = JSON.parse(value) as { agents: AgentRecord[] };
    return registry.agents.find((record) => record.address === ADDRESS)!;
  });
}

describe("explicit cleanup-quarantine recovery", () => {
  it("records a durable operator-attested exact-generation release without restart, archive, or mail delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-recovery-"));
    await seedPersistedUnknown(root);
    const workers: FakeWorker[] = [];
    const broker = await brokerAt(root, workers);
    let queuedId = "";
    try {
      const queued = await broker.send(broker.mainAddress, {
        to: ADDRESS, subject: "Queued", message: "Remain queued after release.", priority: "low",
      });
      assert.equal(queued.envelope.deliveryState, "queued");
      queuedId = queued.envelope.id;
      const deferredAddress = "worker.deferred-release@gpt-5.4.com";
      assert.equal(broker.inspectAgent(deferredAddress).capacityAvailable, false, "cleanup quarantine holds mutable admission");
      const before = broker.getSnapshot().capacity;

      const audit = await broker.recoverCleanup(ADDRESS, 9, EVIDENCE);

      assert.equal(audit.source, "operator-attested");
      assert.equal(audit.workerGeneration, 9);
      assert.equal(audit.evidence, EVIDENCE);
      assert.ok(Number.isFinite(Date.parse(audit.releasedAt)));
      const inspection = broker.inspectAgent(ADDRESS);
      assert.equal(inspection.state, "failed");
      assert.equal(inspection.cleanup, undefined);
      assert.deepEqual(inspection.lastCleanupRecovery, {
        workerGeneration: audit.workerGeneration,
        releasedAt: audit.releasedAt,
        source: audit.source,
      });
      assert.equal((inspection.lastCleanupRecovery as any).evidence, undefined, "inspect omits the evidence body");
      assert.equal(inspection.capacity.runSlotsUsed, before.runSlotsUsed);
      assert.equal(inspection.holdsActivationLease, true, "operator release is not archive");
      assert.equal(workers.length, 0, "recovery never creates a worker");
      assert.equal(broker.mailStore.get(queued.envelope.id)?.deliveryState, "queued", "recovery never delivers target mail");
      assert.equal(broker.inspectAgent(deferredAddress).capacityAvailable, true, "exact quarantine capacity is released without spawning");

      const persisted = await storedRecord(root);
      assert.equal(persisted.cleanup, undefined);
      assert.deepEqual(persisted.lastCleanupRecovery, audit);
      assert.equal(persisted.workerEpoch?.phase, "operator-released");
      assert.equal(persisted.workerEpoch?.runSlotHeld, false);
    } finally {
      await broker.shutdown();
    }

    const restoredWorkers: FakeWorker[] = [];
    const restored = await brokerAt(root, restoredWorkers);
    try {
      const inspection = restored.inspectAgent(ADDRESS);
      assert.equal(inspection.cleanup, undefined);
      assert.equal(inspection.state, "failed");
      assert.equal(inspection.lastCleanupRecovery?.source, "operator-attested");
      assert.equal(restored.mailStore.get(queuedId)?.deliveryState, "queued");
      assert.equal(restoredWorkers.length, 0, "operator-released must never auto-restore a worker");

      await restored.restart(ADDRESS);
      assert.equal(restoredWorkers.length, 1, "a later explicit restart creates exactly one worker");
      await waitForDelivery(restored, queuedId);
      const restarted = restored.getSnapshot().agents.find((candidate) => candidate.address === ADDRESS)!;
      assert.equal(restarted.workerEpoch?.generation, 10);
      assert.equal(restarted.workerEpoch?.phase, "activated");

      const beforeStaleRetry = await readFile(join(root, "state", "registry.json"), "utf8");
      await assert.rejects(executeCleanupRecoveryCommand(
        `recover-cleanup ${ADDRESS} 9 --confirm ${EVIDENCE}`,
        restored,
        join(root, "state"),
      ), /stale|current.*generation|no cleanup quarantine/i);
      assert.equal(await readFile(join(root, "state", "registry.json"), "utf8"), beforeStaleRetry);
    } finally {
      await restored.shutdown();
    }
  });

  it("keeps manage_agent mechanically unable to recover byte-identical quarantine while the direct human command succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-command-boundary-"));
    await seedPersistedUnknown(root);
    const broker = await brokerAt(root);
    try {
      const registryPath = join(root, "state", "registry.json");
      const before = await readFile(registryPath, "utf8");
      const manage = createMainCoordinationTools(() => broker)[3];
      await assert.rejects(manage.execute("forged-recovery", {
        address: ADDRESS,
        action: "recover_cleanup",
        workerGeneration: 9,
        operatorEvidence: "Model-forged evidence must never be accepted.",
      } as never, undefined, undefined, {} as never), /unsupported.*action|could not manage/i);
      assert.equal(await readFile(registryPath, "utf8"), before, "model tool attempt must preserve quarantine byte-for-byte");
      assert.equal(broker.inspectAgent(ADDRESS).cleanup?.workerGeneration, 9);

      const result = await executeCleanupRecoveryCommand(
        `recover-cleanup ${ADDRESS} 9 --confirm ${EVIDENCE}`,
        broker,
        join(root, "state"),
      );
      assert.equal(result.audit.source, "operator-attested");
      assert.equal(result.offline, false);
      assert.equal(broker.inspectAgent(ADDRESS).cleanup, undefined);
      assert.equal(broker.inspectAgent(ADDRESS).state, "failed");
    } finally {
      await broker.shutdown();
    }
  });

  it("releases a settled same-process unknown lease but never a pending cleanup operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-online-lease-"));
    class UnknownCleanupWorker extends FakeWorker {
      override cleanup(): Promise<any> {
        return Promise.resolve({
          sessionDisposed: true,
          providerQuiescent: true,
          tools: [],
          quiescence: "unknown",
          source: "no-process-receipt",
          abort: "succeeded",
          dispose: "succeeded",
        });
      }
    }
    const worker = new UnknownCleanupWorker();
    const broker = new AgentBroker({
      cwd: root,
      agentDir: root,
      namespaceDir: join(root, "state"),
      config: structuredClone(DEFAULT_CONFIG),
      models: [fakeModel("gpt-5.4")],
      mainAdapter: new FakeMainAdapter(),
      workerFactory: () => worker,
      projectTrusted: true,
    });
    await broker.init();
    const sent = await broker.send(broker.mainAddress, { to: ADDRESS, subject: "Online", message: "Finish first.", priority: "low" });
    await worker.send({
      to: broker.mainAddress,
      subject: makeReplySubject(sent.envelope.id, sent.envelope.subject),
      message: "Done.",
      priority: "low",
    });
    worker.settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(broker.stop(ADDRESS), /cleanup.*quarantin|quiescence.*unknown/i);
    assert.equal((broker as any).cleanupQuarantines.get(ADDRESS)?.operationSettled, true);
    const audit = await broker.recoverCleanup(ADDRESS, 1, EVIDENCE);
    assert.equal(audit.source, "operator-attested");
    assert.equal((broker as any).cleanupQuarantines.has(ADDRESS), false);
    assert.equal(broker.inspectAgent(ADDRESS).state, "failed");
    await broker.shutdown();
  });

  it("is idempotent for the exact audit and rejects conflicting retries without mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-retry-"));
    await seedPersistedUnknown(root);
    const broker = await brokerAt(root);
    try {
      const first = await broker.recoverCleanup(ADDRESS, 9, EVIDENCE);
      const second = await broker.recoverCleanup(ADDRESS, 9, EVIDENCE);
      assert.deepEqual(second, first);
      const before = await readFile(join(root, "state", "registry.json"), "utf8");
      await assert.rejects(broker.recoverCleanup(ADDRESS, 9, "A different operator statement is conflicting."), /conflict|already.*released/i);
      await assert.rejects(broker.recoverCleanup(ADDRESS, 10, EVIDENCE), /generation|already.*released/i);
      assert.equal(await readFile(join(root, "state", "registry.json"), "utf8"), before);
    } finally {
      await broker.shutdown();
    }
  });

  it("rejects unsafe state facts and missing evidence without mutation", async () => {
    for (const [label, overrides, generation, evidence, pattern] of [
      ["pending cleanup", { state: "pending" }, 9, EVIDENCE, /pending|unknown cleanup/i],
      ["pending abort", { abort: "pending" }, 9, EVIDENCE, /pending/i],
      ["active tool", { activeTools: [{ toolCallId: "bash-9", toolName: "bash" }] }, 9, EVIDENCE, /active tool/i],
      ["run slot", { heldRunSlot: true }, 9, EVIDENCE, /run slot/i],
      ["generation", {}, 8, EVIDENCE, /generation/i],
      ["reason", {}, 9, "", /evidence|reason/i],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `pi-email-cleanup-reject-${label.replace(/\s/g, "-")}-`));
      await seedPersistedUnknown(root);
      const broker = await brokerAt(root);
      try {
        const internal = broker as any;
        const record = internal.records.get(ADDRESS) as AgentRecord;
        Object.assign(record.cleanup!, overrides);
        const beforeRecord = structuredClone(record);
        const before = await readFile(join(root, "state", "registry.json"), "utf8");
        await assert.rejects(broker.recoverCleanup(ADDRESS, generation, evidence), pattern, label);
        assert.deepEqual(internal.records.get(ADDRESS), beforeRecord, label);
        assert.equal(await readFile(join(root, "state", "registry.json"), "utf8"), before, label);
      } finally {
        await broker.shutdown().catch(() => undefined);
      }
    }

    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-reject-missing-"));
    await seedPersistedUnknown(root);
    const broker = await brokerAt(root);
    const record = (broker as any).records.get(ADDRESS) as AgentRecord;
    delete record.cleanup;
    await assert.rejects(broker.recoverCleanup(ADDRESS, 9, EVIDENCE), /no cleanup quarantine/i);
    await broker.shutdown();
  });

  it("rejects attached workers, pending factories, provisional workers, and concurrent lifecycle operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-live-reject-"));
    await seedPersistedUnknown(root);
    const broker = await brokerAt(root);
    const internal = broker as any;
    const record = internal.records.get(ADDRESS) as AgentRecord;
    const marker = new FakeWorker();
    internal.workers.set(ADDRESS, marker);
    await assert.rejects(broker.recoverCleanup(ADDRESS, 9, EVIDENCE), /attached|live worker/i);
    internal.workers.delete(ADDRESS);
    internal.pendingFactories.set(ADDRESS, { workerGeneration: 9 });
    await assert.rejects(broker.recoverCleanup(ADDRESS, 9, EVIDENCE), /pending.*factory|worker factory/i);
    internal.pendingFactories.delete(ADDRESS);
    internal.provisionalWorkers.add(marker);
    internal.workerAddresses.set(marker, ADDRESS);
    await assert.rejects(broker.recoverCleanup(ADDRESS, 9, EVIDENCE), /provisional/i);
    internal.provisionalWorkers.delete(marker);
    const blocker = new Promise<void>(() => undefined);
    internal.addressTails.set(ADDRESS, blocker);
    await assert.rejects(broker.recoverCleanup(ADDRESS, 9, EVIDENCE), /lifecycle operation/i);
    internal.addressTails.delete(ADDRESS);
    assert.ok(record.cleanup);
    await broker.shutdown().catch(() => undefined);
  });

  it("rolls back on persistence failure and restores coherently after a committed release", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-cleanup-persist-rollback-"));
    await seedPersistedUnknown(root);
    const broker = await brokerAt(root);
    const before = structuredClone(broker.getSnapshot().agents.find((record) => record.address === ADDRESS));
    const original = broker.registryStore.save.bind(broker.registryStore);
    let fail = true;
    broker.registryStore.save = async (registry) => {
      if (fail && registry.agents.some((record) => record.address === ADDRESS && record.lastCleanupRecovery)) {
        fail = false;
        throw new Error("operator recovery persistence failed");
      }
      await original(registry);
    };
    await assert.rejects(broker.recoverCleanup(ADDRESS, 9, EVIDENCE), /persistence failed/i);
    assert.deepEqual(broker.getSnapshot().agents.find((record) => record.address === ADDRESS), before);
    const committed = await broker.recoverCleanup(ADDRESS, 9, EVIDENCE);
    await broker.shutdown();

    const restored = await brokerAt(root);
    try {
      const record = restored.getSnapshot().agents.find((candidate) => candidate.address === ADDRESS)!;
      assert.equal(record.cleanup, undefined);
      assert.deepEqual(record.lastCleanupRecovery, committed);
      assert.equal(record.workerEpoch?.phase, "operator-released");
    } finally {
      await restored.shutdown();
    }
  });
});
