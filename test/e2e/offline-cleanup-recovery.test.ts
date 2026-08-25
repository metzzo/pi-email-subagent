import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { recoverOrphanedCleanup } from "../../src/cleanup-recovery.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { NamespaceLock } from "../../src/namespace-lock.ts";
import { FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

const ADDRESS = "worker.offline-release@gpt-5.4.com";
const OTHER = "worker.preserved@gpt-5.4.com";
const EVIDENCE = "Operator inspected the external process tree and confirmed quiescence.";

async function brokerAt(root: string): Promise<AgentBroker> {
  const broker = new AgentBroker({
    cwd: root,
    agentDir: root,
    namespaceDir: join(root, "state"),
    config: structuredClone(DEFAULT_CONFIG),
    models: [fakeModel("gpt-5.4")],
    mainAdapter: new FakeMainAdapter(),
    workerFactory: () => new FakeWorker(),
    projectTrusted: true,
  });
  await broker.init();
  return broker;
}

async function seed(root: string): Promise<{ namespaceDir: string; registryBefore: any; mailBefore: string; queuedId: string }> {
  const broker = await brokerAt(root);
  await broker.send(broker.mainAddress, { to: ADDRESS, subject: "Target", message: "Keep target obligation.", priority: "low" });
  await broker.stop(ADDRESS);
  const queued = await broker.send(broker.mainAddress, { to: ADDRESS, subject: "Queued target", message: "Keep this queued mail.", priority: "low" });
  assert.equal(queued.envelope.deliveryState, "queued");
  await broker.send(broker.mainAddress, { to: OTHER, subject: "Other", message: "Keep other record.", priority: "low" });
  await broker.shutdown();
  const namespaceDir = join(root, "state");
  const registryPath = join(namespaceDir, "registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as any;
  const targetRecord = registry.agents.find((record: any) => record.address === ADDRESS);
  const now = new Date().toISOString();
  targetRecord.state = "failed";
  targetRecord.failure = "Cleanup quarantine: quiescence unknown.";
  targetRecord.sessionFile = join(namespaceDir, "sessions", "preserved-session.jsonl");
  targetRecord.workerEpoch = {
    generation: 9, phase: "activated", tools: ["bash"], mutationCapable: true, runSlotHeld: false,
  };
  targetRecord.cleanup = {
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
  };
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const mailBefore = await readFile(join(namespaceDir, "mail.jsonl"), "utf8");
  return { namespaceDir, registryBefore: registry, mailBefore, queuedId: queued.envelope.id };
}

async function waitForHolder(child: ReturnType<typeof spawn>, stderr: () => string): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for holder: ${stderr()}`)), 10_000);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = /^READY (\d+)$/m.exec(stdout);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      if (!/^READY /m.test(stdout)) { clearTimeout(timer); reject(new Error(`Holder exited ${code}/${signal}: ${stderr()}`)); }
    });
  });
}

async function deadOwnerIdentity(namespaceDir: string, token: string): Promise<Record<string, unknown>> {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  return {
    pid: 999_999_999,
    token,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    namespaceDir,
    bootId,
    processStartTime: "1",
  };
}

async function deadOwner(namespaceDir: string): Promise<void> {
  await writeFile(join(namespaceDir, ".broker-owner.json"), `${JSON.stringify(await deadOwnerIdentity(namespaceDir, "dead-exact-owner"), null, 2)}\n`);
  await mkdir(`${namespaceDir}.lock`);
}

describe("startup-blocked cleanup recovery", { skip: process.platform !== "linux" ? "Linux /proc owner identity is required" : false }, () => {
  it("backs up and atomically releases only a dead exact owner after an explicit confirmed audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-recovery-"));
    const seeded = await seed(root);
    await deadOwner(seeded.namespaceDir);
    const order: string[] = [];
    const result = await recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS,
      workerGeneration: 9,
      evidence: `${EVIDENCE} Authorization: Bearer super-secret-token`,
      confirmed: true,
    }, {
      afterGuardAcquired: () => { order.push("guard"); },
      afterOwnerVerified: () => { order.push("owner-verified"); },
      afterBackupCreated: () => { order.push("backup"); },
      afterRegistryCommitted: () => { order.push("registry"); },
      afterLockRemoved: () => { order.push("lock-removed"); },
      afterOwnerRemoved: () => { order.push("owner-removed"); },
    });

    assert.deepEqual(order, ["guard", "owner-verified", "backup", "registry", "lock-removed", "owner-removed"]);
    assert.equal(result.audit.source, "operator-attested");
    assert.equal(result.audit.workerGeneration, 9);
    assert.match(result.audit.evidence, /Authorization: \[redacted\]/i);
    assert.doesNotMatch(result.audit.evidence, /super-secret-token/);
    assert.equal(result.nextStep, "Run /reload, then explicitly restart or archive the recovered identity as appropriate.");
    await assert.rejects(stat(join(seeded.namespaceDir, ".broker-owner.json")), /ENOENT/);
    await assert.rejects(stat(`${seeded.namespaceDir}.lock`), /ENOENT/);
    assert.equal(await readFile(join(seeded.namespaceDir, "mail.jsonl"), "utf8"), seeded.mailBefore);

    const registry = JSON.parse(await readFile(join(seeded.namespaceDir, "registry.json"), "utf8")) as any;
    const recovered = registry.agents.find((record: any) => record.address === ADDRESS);
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.cleanup, undefined);
    assert.equal(recovered.workerEpoch.phase, "operator-released");
    assert.equal(recovered.sessionFile, join(seeded.namespaceDir, "sessions", "preserved-session.jsonl"));
    assert.deepEqual(registry.agents.find((record: any) => record.address === OTHER), seeded.registryBefore.agents.find((record: any) => record.address === OTHER));

    const backups = (await readdir(seeded.namespaceDir)).filter((name) => name.startsWith("registry.json.cleanup-recovery-") && name.endsWith(".bak"));
    assert.equal(backups.length, 1);
    const backup = JSON.parse(await readFile(join(seeded.namespaceDir, backups[0]!), "utf8")) as any;
    assert.equal(backup.agents.find((record: any) => record.address === ADDRESS).cleanup.workerGeneration, 9);

    const reloaded = await brokerAt(root);
    try {
      const inspection = reloaded.inspectAgent(ADDRESS);
      assert.equal(inspection.state, "failed");
      assert.equal(inspection.cleanup, undefined);
      assert.equal(inspection.lastCleanupRecovery?.source, "operator-attested");
      assert.equal(reloaded.mailStore.get(seeded.queuedId)?.deliveryState, "queued");
      assert.equal(reloaded.mailStore.get(seeded.queuedId)?.answeredAt, undefined);
    } finally {
      await reloaded.shutdown();
    }
  });

  it("rejects a live exact owner, including the current process, without changing registry or artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-live-"));
    const seeded = await seed(root);
    const owner = await NamespaceLock.acquire(seeded.namespaceDir, () => undefined);
    try {
      const before = await readFile(join(seeded.namespaceDir, "registry.json"), "utf8");
      await assert.rejects(recoverOrphanedCleanup(seeded.namespaceDir, {
        address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
      }), new RegExp(`owner.*${process.pid}.*live|live.*owner`, "i"));
      assert.equal(await readFile(join(seeded.namespaceDir, "registry.json"), "utf8"), before);
      assert.equal((JSON.parse(await readFile(join(seeded.namespaceDir, ".broker-owner.json"), "utf8")) as any).pid, process.pid);
    } finally {
      await owner.release();
    }
  });

  it("rejects the exact SIGSTOPed namespace owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-sigstop-"));
    const seeded = await seed(root);
    const child = spawn(process.execPath, ["--import", "tsx", "test/e2e/helpers/namespace-lock-holder.ts", seeded.namespaceDir], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      const pid = await waitForHolder(child, () => stderr);
      assert.equal(child.kill("SIGSTOP"), true);
      await assert.rejects(recoverOrphanedCleanup(seeded.namespaceDir, {
        address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
      }), new RegExp(`owner pid ${pid}.*still live|still live.*${pid}`, "i"));
      assert.ok((await stat(join(seeded.namespaceDir, ".broker-owner.json"))).isFile());
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGCONT");
        child.kill("SIGKILL");
      }
      await closed;
    }
  });

  it("fails closed on missing confirmation, malformed identity, wrong generation, and registry or owner races", async () => {
    for (const scenario of ["confirmation", "identity", "generation", "registry-race", "owner-race"] as const) {
      const root = await mkdtemp(join(tmpdir(), `pi-email-offline-${scenario}-`));
      const seeded = await seed(root);
      await deadOwner(seeded.namespaceDir);
      if (scenario === "identity") {
        const malformed = JSON.parse(await readFile(join(seeded.namespaceDir, ".broker-owner.json"), "utf8"));
        delete malformed.bootId;
        await writeFile(join(seeded.namespaceDir, ".broker-owner.json"), JSON.stringify(malformed));
      }
      const before = await readFile(join(seeded.namespaceDir, "registry.json"), "utf8");
      const hooks = scenario === "registry-race" ? {
        afterBackupCreated: async () => { await writeFile(join(seeded.namespaceDir, "registry.json"), `${before} `); },
      } : scenario === "owner-race" ? {
        afterBackupCreated: async () => {
          const path = join(seeded.namespaceDir, ".broker-owner.json");
          const value = JSON.parse(await readFile(path, "utf8"));
          value.token = "racing-owner";
          await writeFile(path, JSON.stringify(value));
        },
      } : undefined;
      await assert.rejects(recoverOrphanedCleanup(seeded.namespaceDir, {
        address: ADDRESS,
        workerGeneration: scenario === "generation" ? 8 : 9,
        evidence: EVIDENCE,
        confirmed: scenario !== "confirmation",
      }, hooks), /confirm|identity|boot|generation|changed|race/i, scenario);
      if (scenario !== "registry-race") {
        assert.equal(await readFile(join(seeded.namespaceDir, "registry.json"), "utf8"), before, scenario);
      }
    }
  });

  it("recovers idempotently after a crash window immediately following the durable registry commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-post-commit-"));
    const seeded = await seed(root);
    await deadOwner(seeded.namespaceDir);
    await assert.rejects(recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    }, { afterRegistryCommitted: () => { throw new Error("simulated crash after commit"); } }), /simulated crash/);
    const committed = JSON.parse(await readFile(join(seeded.namespaceDir, "registry.json"), "utf8")) as any;
    const record = committed.agents.find((candidate: any) => candidate.address === ADDRESS);
    assert.equal(record.cleanup, undefined);
    assert.equal(record.workerEpoch.phase, "operator-released");
    assert.ok(await stat(join(seeded.namespaceDir, ".broker-owner.json")));
    assert.ok(await stat(`${seeded.namespaceDir}.lock`));
    await writeFile(
      join(seeded.namespaceDir, ".cleanup-recovery.guard"),
      `${JSON.stringify(await deadOwnerIdentity(seeded.namespaceDir, "crashed-recovery-operation"), null, 2)}\n`,
    );

    const retried = await recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    });
    assert.deepEqual(retried.audit, record.lastCleanupRecovery);
    await assert.rejects(stat(join(seeded.namespaceDir, ".broker-owner.json")), /ENOENT/);
    await assert.rejects(stat(`${seeded.namespaceDir}.lock`), /ENOENT/);
  });

  it("uses an exclusive recovery guard and exact retries return the existing audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-guard-"));
    const seeded = await seed(root);
    await deadOwner(seeded.namespaceDir);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const first = recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    }, { afterGuardAcquired: async () => { entered(); await held; } });
    await ready;
    await assert.rejects(recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    }), /recovery operation.*in progress|guard/i);
    release();
    const completed = await first;

    // Recreate only the exact orphan artifacts to exercise crash/idempotent cleanup after a committed registry rewrite.
    await deadOwner(seeded.namespaceDir);
    const retried = await recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    });
    assert.deepEqual(retried.audit, completed.audit);
  });
});
