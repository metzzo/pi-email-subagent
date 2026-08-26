import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentBroker } from "../../src/broker.ts";
import { recoverOrphanedCleanup } from "../../src/cleanup-recovery.ts";
import { createCleanupRecoveryProposalCapability } from "../../src/confirmed-cleanup-recovery.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { NamespaceLock } from "../../src/namespace-lock.ts";
import { FakeMainAdapter, FakeWorker, fakeModel } from "../helpers/fakes.ts";

const ADDRESS = "worker.offline-release@gpt-5.4.com";
const OTHER = "worker.preserved@gpt-5.4.com";
const EVIDENCE = "Operator inspected the external process tree and confirmed quiescence.";

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

async function seed(root: string): Promise<{ namespaceDir: string; registryBefore: any; mailBefore: string; queuedId: string; otherQueuedId: string }> {
  const broker = await brokerAt(root);
  const targetInitial = await broker.send(broker.mainAddress, { to: ADDRESS, subject: "Target", message: "Create target identity.", priority: "low" });
  await broker.stop(ADDRESS);
  await broker.cancelRequest(targetInitial.envelope.id, "Fixture closes the target identity-creation request.");
  const queued = await broker.send(broker.mainAddress, { to: ADDRESS, subject: "Queued target", message: "Keep this queued mail.", priority: "low" });
  assert.equal(queued.envelope.deliveryState, "queued");
  const otherInitial = await broker.send(broker.mainAddress, { to: OTHER, subject: "Other", message: "Create other identity.", priority: "low" });
  await broker.stop(OTHER);
  await broker.cancelRequest(otherInitial.envelope.id, "Fixture closes the other identity-creation request.");
  const otherQueued = await broker.send(broker.mainAddress, { to: OTHER, subject: "Other queued", message: "Keep other queued mail.", priority: "low" });
  assert.equal(otherQueued.envelope.deliveryState, "queued");
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
  return { namespaceDir, registryBefore: registry, mailBefore, queuedId: queued.envelope.id, otherQueuedId: otherQueued.envelope.id };
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

async function runRecoveryChild(namespaceDir: string, marker: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--import", "tsx", "test/e2e/helpers/offline-cleanup-recovery-runner.ts",
    namespaceDir, ADDRESS, "9", EVIDENCE, marker,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

async function waitForDelivery(broker: AgentBroker, id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (broker.mailStore.get(id)?.deliveryState === "delivered") return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
  }
  assert.fail(`mail ${id} was not delivered after explicit restart`);
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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

function approvedOfflineCapability(namespaceDir: string) {
  const context = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "approved-offline" },
    ui: { confirm: async () => true },
  } as unknown as ExtensionContext;
  return createCleanupRecoveryProposalCapability({
    getState: () => ({ context, generation: 1, broker: undefined }),
    namespaceDir: () => namespaceDir,
  });
}

describe("startup-blocked cleanup recovery", { skip: process.platform !== "linux" ? "Linux /proc owner identity is required" : false }, () => {
  it("requires a live UI approval before the shared startup-blocked callback reads or mutates orphan state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-confirmed-proposal-"));
    const seeded = await seed(root);
    await deadOwner(seeded.namespaceDir);
    const registryPath = join(seeded.namespaceDir, "registry.json");
    const ownerPath = join(seeded.namespaceDir, ".broker-owner.json");
    const lockPath = `${seeded.namespaceDir}.lock`;
    const registryBefore = await readFile(registryPath, "utf8");
    const ownerBefore = await readFile(ownerPath, "utf8");
    const lockBefore = await stat(lockPath);
    let approved = false;
    let prompts = 0;
    const context = {
      mode: "rpc",
      hasUI: true,
      sessionManager: { getSessionId: () => "offline-confirmed" },
      ui: { confirm: async () => { prompts += 1; return approved; } },
    } as unknown as ExtensionContext;
    const capability = createCleanupRecoveryProposalCapability({
      getState: () => ({ context, generation: 3, broker: undefined }),
      namespaceDir: () => seeded.namespaceDir,
    });
    const proposal = { address: ADDRESS, workerGeneration: 9, operatorEvidence: EVIDENCE };

    await assert.rejects(capability.propose("offline-denied", proposal), /proposal rejected.*denied/i);
    assert.equal(await readFile(registryPath, "utf8"), registryBefore);
    assert.equal(await readFile(ownerPath, "utf8"), ownerBefore);
    const lockAfterDenial = await stat(lockPath);
    assert.deepEqual(
      [lockAfterDenial.ino, lockAfterDenial.mode, lockAfterDenial.mtimeMs],
      [lockBefore.ino, lockBefore.mode, lockBefore.mtimeMs],
    );
    assert.equal((await readdir(seeded.namespaceDir)).some((name) => name.includes("cleanup-recovery")), false);

    approved = true;
    const recovered = await capability.propose("offline-approved", proposal);
    assert.equal(prompts, 2);
    assert.equal(recovered.address, ADDRESS);
    assert.equal(recovered.offline, true);
    assert.equal(recovered.audit.workerGeneration, 9);
    assert.equal(recovered.nextStep, "Run /reload, then explicitly restart or archive the recovered identity as appropriate.");
    await assert.rejects(stat(ownerPath), /ENOENT/);
    await assert.rejects(stat(lockPath), /ENOENT/);
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as any;
    assert.equal(registry.agents.find((record: any) => record.address === ADDRESS).workerEpoch.phase, "operator-released");
  });

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

    const reloadedWorkers: FakeWorker[] = [];
    const reloaded = await brokerAt(root, reloadedWorkers);
    try {
      const inspection = reloaded.inspectAgent(ADDRESS);
      assert.equal(inspection.state, "failed");
      assert.equal(inspection.cleanup, undefined);
      assert.equal(inspection.lastCleanupRecovery?.source, "operator-attested");
      assert.equal(reloaded.mailStore.get(seeded.queuedId)?.deliveryState, "queued");
      assert.equal(reloaded.mailStore.get(seeded.queuedId)?.answeredAt, undefined);
      assert.equal(reloadedWorkers.length, 0, "operator-released and stopped records must not auto-restore");
      await reloaded.restart(ADDRESS);
      assert.equal(reloadedWorkers.length, 1, "only explicit restart creates one worker");
      await waitForDelivery(reloaded, seeded.queuedId);
      const restarted = reloaded.getSnapshot().agents.find((candidate) => candidate.address === ADDRESS)!;
      assert.equal(restarted.workerEpoch?.generation, 10);
      assert.equal(restarted.workerEpoch?.phase, "activated");
    } finally {
      await reloaded.shutdown();
    }
  });

  it("normalizes every unsafe dead-owner record before releasing only the requested generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-namespace-normalize-"));
    const seeded = await seed(root);
    const registryPath = join(seeded.namespaceDir, "registry.json");
    const before = JSON.parse(await readFile(registryPath, "utf8")) as any;
    const unsafeOther = before.agents.find((record: any) => record.address === OTHER);
    unsafeOther.state = "paused";
    delete unsafeOther.cleanup;
    unsafeOther.workerEpoch = {
      generation: 7,
      phase: "activated",
      tools: ["bash"],
      mutationCapable: true,
      runSlotHeld: false,
    };
    await writeFile(registryPath, `${JSON.stringify(before, null, 2)}\n`);
    const mailBefore = await readFile(join(seeded.namespaceDir, "mail.jsonl"), "utf8");
    await deadOwner(seeded.namespaceDir);

    await recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    });

    const normalized = JSON.parse(await readFile(registryPath, "utf8")) as any;
    const released = normalized.agents.find((record: any) => record.address === ADDRESS);
    const quarantined = normalized.agents.find((record: any) => record.address === OTHER);
    assert.equal(released.cleanup, undefined);
    assert.equal(released.workerEpoch.phase, "operator-released");
    assert.equal(released.state, "failed");
    assert.equal(quarantined.state, "failed");
    assert.equal(quarantined.cleanup.reasonCode, "ABANDONED_OWNER_RECOVERY");
    assert.equal(quarantined.cleanup.workerGeneration, 7);
    assert.equal(quarantined.cleanup.quiescence, "unknown");
    assert.equal(quarantined.workerEpoch.phase, "activated");
    assert.equal(await readFile(join(seeded.namespaceDir, "mail.jsonl"), "utf8"), mailBefore);

    const workers: FakeWorker[] = [];
    const reacquired = await brokerAt(root, workers);
    try {
      assert.equal(workers.length, 0, "reload must create no replacement for either released A or quarantined B");
      assert.equal(reacquired.inspectAgent(OTHER).cleanup?.reasonCode, "ABANDONED_OWNER_RECOVERY");
      assert.equal(reacquired.mailStore.get(seeded.otherQueuedId)?.deliveryState, "queued");
      await reacquired.restart(ADDRESS);
      assert.equal(workers.length, 1, "explicit A restart creates only A");
      assert.equal(reacquired.mailStore.get(seeded.queuedId)?.deliveryState, "queued", "B quarantine still blocks mutable scheduling");
      assert.equal(reacquired.mailStore.get(seeded.otherQueuedId)?.deliveryState, "queued");
      assert.equal(reacquired.inspectAgent(OTHER).cleanup?.workerGeneration, 7);
    } finally {
      await reacquired.shutdown().catch(() => undefined);
    }
  });

  it("rejects a live exact owner, including the current process, without changing registry or artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-live-"));
    const seeded = await seed(root);
    const owner = await NamespaceLock.acquire(seeded.namespaceDir, () => undefined);
    try {
      const before = await readFile(join(seeded.namespaceDir, "registry.json"), "utf8");
      await assert.rejects(approvedOfflineCapability(seeded.namespaceDir).propose("approved-live-owner", {
        address: ADDRESS, workerGeneration: 9, operatorEvidence: EVIDENCE,
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
      await assert.rejects(approvedOfflineCapability(seeded.namespaceDir).propose("approved-sigstop-owner", {
        address: ADDRESS, workerGeneration: 9, operatorEvidence: EVIDENCE,
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

  it("migrates an exact paused operator-release from the prior candidate during offline crash retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-prior-release-migration-"));
    const seeded = await seed(root);
    const registryPath = join(seeded.namespaceDir, "registry.json");
    const prior = JSON.parse(await readFile(registryPath, "utf8")) as any;
    const target = prior.agents.find((candidate: any) => candidate.address === ADDRESS);
    const sessionFile = target.sessionFile;
    const releasedAt = "2026-08-25T01:23:45.000Z";
    const audit = {
      workerGeneration: 9,
      releasedAt,
      evidence: EVIDENCE,
      source: "operator-attested",
    };
    target.state = "paused";
    delete target.cleanup;
    target.workerEpoch = {
      generation: 9, phase: "operator-released", tools: ["bash"], mutationCapable: true, runSlotHeld: false,
    };
    target.lastCleanupRecovery = audit;
    target.failure = "Cleanup quarantine operator-released for worker generation 9 by operator attestation; Pi did not verify quiescence. Explicit restart or archive is required.";
    target.currentActivity = "Cleanup operator-released for generation 9; Pi did not verify quiescence";
    target.updatedAt = releasedAt;
    await writeFile(registryPath, `${JSON.stringify(prior, null, 2)}\n`);
    const mailBefore = await readFile(join(seeded.namespaceDir, "mail.jsonl"), "utf8");
    const otherBefore = structuredClone(prior.agents.find((candidate: any) => candidate.address === OTHER));
    await deadOwner(seeded.namespaceDir);

    const retried = await recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    });
    assert.equal(retried.idempotent, true);
    assert.deepEqual(retried.audit, audit);
    await assert.rejects(stat(join(seeded.namespaceDir, ".broker-owner.json")), /ENOENT/);
    await assert.rejects(stat(`${seeded.namespaceDir}.lock`), /ENOENT/);
    assert.equal(await readFile(join(seeded.namespaceDir, "mail.jsonl"), "utf8"), mailBefore);

    const canonical = JSON.parse(await readFile(registryPath, "utf8")) as any;
    const migrated = canonical.agents.find((candidate: any) => candidate.address === ADDRESS);
    assert.equal(migrated.state, "failed");
    assert.equal(migrated.cleanup, undefined);
    assert.equal(migrated.workerEpoch.phase, "operator-released");
    assert.deepEqual(migrated.lastCleanupRecovery, audit);
    assert.equal(migrated.sessionFile, sessionFile);
    assert.deepEqual(canonical.agents.find((candidate: any) => candidate.address === OTHER), otherBefore);

    const workers: FakeWorker[] = [];
    const reloaded = await brokerAt(root, workers);
    try {
      assert.equal(workers.length, 0, "migrated operator release never auto-restores");
      assert.equal(reloaded.mailStore.get(seeded.queuedId)?.deliveryState, "queued");
      assert.equal(reloaded.inspectAgent(ADDRESS).state, "failed");
      await reloaded.restart(ADDRESS);
      assert.equal(workers.length, 1, "later explicit restart creates exactly one worker");
      await waitForDelivery(reloaded, seeded.queuedId);
      const restarted = reloaded.getSnapshot().agents.find((candidate) => candidate.address === ADDRESS)!;
      assert.equal(restarted.workerEpoch?.generation, 10);
      assert.equal(restarted.workerEpoch?.phase, "activated");
    } finally {
      await reloaded.shutdown();
    }
  });

  it("rejects a stale generation-9 retry after the current epoch advanced to activated generation 10 without touching owner, lock, or registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-stale-retry-"));
    const seeded = await seed(root);
    await deadOwner(seeded.namespaceDir);
    await recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    });

    const registryPath = join(seeded.namespaceDir, "registry.json");
    const advanced = JSON.parse(await readFile(registryPath, "utf8")) as any;
    const record = advanced.agents.find((candidate: any) => candidate.address === ADDRESS);
    record.state = "failed";
    record.workerEpoch = {
      generation: 10, phase: "activated", tools: ["bash"], mutationCapable: true, runSlotHeld: false,
    };
    await writeFile(registryPath, `${JSON.stringify(advanced, null, 2)}\n`);
    await deadOwner(seeded.namespaceDir);

    const ownerPath = join(seeded.namespaceDir, ".broker-owner.json");
    const lockPath = `${seeded.namespaceDir}.lock`;
    const registryBefore = await readFile(registryPath, "utf8");
    const ownerBefore = await readFile(ownerPath, "utf8");
    const lockBefore = await stat(lockPath);
    await assert.rejects(recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    }), /stale|current.*generation|operator-released/i);
    assert.equal(await readFile(registryPath, "utf8"), registryBefore);
    assert.equal(await readFile(ownerPath, "utf8"), ownerBefore);
    const lockAfter = await stat(lockPath);
    assert.deepEqual(
      [lockAfter.ino, lockAfter.mode, lockAfter.size, lockAfter.mtimeMs],
      [lockBefore.ino, lockBefore.mode, lockBefore.size, lockBefore.mtimeMs],
    );
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

    await assert.rejects(recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    }), /guard.*exists|manual.*guard/i);
    assert.ok(await stat(join(seeded.namespaceDir, ".cleanup-recovery.guard")));
    await unlink(join(seeded.namespaceDir, ".cleanup-recovery.guard"));

    const retried = await recoverOrphanedCleanup(seeded.namespaceDir, {
      address: ADDRESS, workerGeneration: 9, evidence: EVIDENCE, confirmed: true,
    });
    assert.deepEqual(retried.audit, record.lastCleanupRecovery);
    await assert.rejects(stat(join(seeded.namespaceDir, ".broker-owner.json")), /ENOENT/);
    await assert.rejects(stat(`${seeded.namespaceDir}.lock`), /ENOENT/);
  });

  it("never auto-reclaims a dead guard across processes; deliberate removal permits exactly one new writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-offline-dead-guard-race-"));
    const seeded = await seed(root);
    await deadOwner(seeded.namespaceDir);
    const guardPath = join(seeded.namespaceDir, ".cleanup-recovery.guard");
    const deadGuard = `${JSON.stringify(await deadOwnerIdentity(seeded.namespaceDir, "dead-guard-g0"), null, 2)}\n`;
    await writeFile(guardPath, deadGuard);
    const registryPath = join(seeded.namespaceDir, "registry.json");
    const registryBefore = await readFile(registryPath, "utf8");
    const ownerBefore = await readFile(join(seeded.namespaceDir, ".broker-owner.json"), "utf8");
    const marker0 = join(root, "writer-0");
    const marker1 = join(root, "writer-1");

    const blocked = await Promise.all([
      runRecoveryChild(seeded.namespaceDir, marker0),
      runRecoveryChild(seeded.namespaceDir, marker1),
    ]);
    for (const result of blocked) {
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /guard.*exists|manual.*guard/i);
    }
    assert.equal(await readFile(guardPath, "utf8"), deadGuard, "dead G0 is never read-then-unlinked or replaced");
    assert.equal(await readFile(registryPath, "utf8"), registryBefore);
    assert.equal(await readFile(join(seeded.namespaceDir, ".broker-owner.json"), "utf8"), ownerBefore);
    assert.equal(await exists(`${marker0}.guard`), false, "blocked writer never acquires the guard");
    assert.equal(await exists(`${marker1}.guard`), false, "blocked writer never acquires the guard");
    assert.equal(await exists(`${marker0}.backup`), false, "blocked writer never reaches backup");
    assert.equal(await exists(`${marker1}.backup`), false, "blocked writer never reaches backup");
    assert.deepEqual(
      (await readdir(seeded.namespaceDir)).filter((name) => name.startsWith("registry.json.cleanup-recovery-")),
      [],
    );

    await unlink(guardPath); // Deliberate operator action after exact dead-guard inspection.
    const marker2 = join(root, "writer-2");
    const allowed = await runRecoveryChild(seeded.namespaceDir, marker2);
    assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
    assert.equal(await exists(`${marker2}.guard`), true);
    assert.equal(await exists(`${marker2}.backup`), true);
    const committed = JSON.parse(await readFile(registryPath, "utf8")) as any;
    assert.equal(committed.agents.find((record: any) => record.address === ADDRESS).workerEpoch.phase, "operator-released");
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
