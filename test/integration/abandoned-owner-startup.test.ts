import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentBroker } from "../../src/broker.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { kernelProcessIdentity, NamespaceLock } from "../../src/namespace-lock.ts";
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

function runFailedTakeover(root: string, stage: "before-save" | "after-save"): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "test/integration/helpers/abandoned-init-failure-runner.ts",
      root,
      stage,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`takeover failure child exited code ${code}, signal ${signal}: ${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); } catch (error) {
        reject(new Error(`invalid takeover failure child output: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}

it("retains exact namespace ownership when abandoned normalization cannot be committed", {
  skip: process.platform !== "linux" ? "exact owner fencing requires Linux /proc" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-dead-owner-save-failure-"));
  const namespaceDir = join(root, "state");
  await mkdir(namespaceDir, { recursive: true });
  const identity = await kernelProcessIdentity(process.pid);
  await writeFile(join(namespaceDir, ".broker-owner.json"), `${JSON.stringify({
    pid: 999_999_999,
    token: "exact-dead-owner-before-save",
    acquiredAt: "2026-09-01T00:00:00.000Z",
    namespaceDir,
    bootId: identity.bootId,
    processStartTime: "1",
  }, null, 2)}\n`);
  await mkdir(`${namespaceDir}.lock`);

  const broker = brokerAt(root, []);
  broker.registryStore.save = async () => { throw new Error("injected normalized registry save failure"); };
  await assert.rejects(broker.init(), /normalization|save failure|safe namespace release/i);

  let replacement: NamespaceLock | undefined;
  let replacementError: unknown;
  try {
    replacement = await NamespaceLock.acquire(namespaceDir, () => undefined);
  } catch (error) {
    replacementError = error;
  }
  try {
    assert.match(String(replacementError), /already owned.*pid|normalization.*not.*committed/i);
  } finally {
    await replacement?.release();
    const retained = (broker as unknown as { namespaceLock?: NamespaceLock }).namespaceLock;
    await retained?.release().catch(() => undefined);
  }
});

it("retries exact-dead takeover safely after failures before and immediately after normalized save", {
  timeout: 30_000,
  skip: process.platform !== "linux" ? "exact owner fencing requires Linux /proc" : false,
}, async () => {
  for (const stage of ["before-save", "after-save"] as const) {
    const root = await mkdtemp(join(tmpdir(), `pi-email-dead-owner-${stage}-`));
    const first = brokerAt(root, []);
    await first.init();
    const initial = await first.send(first.mainAddress, {
      to: ADDRESS,
      subject: `Initial ${stage} obligation`,
      message: "Preserve the delivered unanswered request.",
      priority: "low",
    });
    await first.stop(ADDRESS);
    const queued = await first.send(first.mainAddress, {
      to: ADDRESS,
      subject: `Queued ${stage} obligation`,
      message: "Preserve the queued request.",
      priority: "low",
    });
    await first.shutdown();

    const namespaceDir = join(root, "state");
    const registryPath = join(namespaceDir, "registry.json");
    const sessionFile = join(namespaceDir, "sessions", `${stage}-session.jsonl`);
    await mkdir(join(namespaceDir, "sessions"), { recursive: true });
    await writeFile(sessionFile, "{}\n");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as any;
    const record = registry.agents.find((candidate: any) => candidate.address === ADDRESS);
    record.state = "running";
    record.sessionFile = sessionFile;
    record.workerEpoch = {
      generation: 9,
      phase: "activated",
      tools: ["bash", "send_email", "fetch_emails"],
      mutationCapable: true,
      runSlotHeld: true,
    };
    delete record.cleanup;
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const identity = await kernelProcessIdentity(process.pid);
    await writeFile(join(namespaceDir, ".broker-owner.json"), `${JSON.stringify({
      pid: 999_999_999,
      token: `exact-dead-owner-${stage}`,
      acquiredAt: "2026-09-01T00:00:00.000Z",
      namespaceDir,
      bootId: identity.bootId,
      processStartTime: "1",
    }, null, 2)}\n`);
    await mkdir(`${namespaceDir}.lock`);

    const failed = await runFailedTakeover(root, stage);
    assert.equal(failed.stage, stage);
    assert.match(failed.error, /normalization.*not durably committed|safe namespace release/i);
    assert.equal(failed.workers, 0, `${stage}: no worker starts before normalized commit`);
    assert.ok(Number.isSafeInteger(failed.ownerPid) && failed.ownerPid > 0);
    assert.equal(failed.sessionFile, sessionFile);

    const restoredWorkers: FakeWorker[] = [];
    const restored = brokerAt(root, restoredWorkers);
    await restored.init();
    try {
      const inspection = restored.inspectAgent(ADDRESS);
      assert.equal(inspection.state, "failed", `${stage}: retry remains inactive`);
      const persisted = JSON.parse(await readFile(registryPath, "utf8")) as any;
      const normalized = persisted.agents.find((candidate: any) => candidate.address === ADDRESS);
      assert.equal(normalized.workerEpoch?.phase, "session-settled", `${stage}: retry normalizes the abandoned generation`);
      assert.equal(normalized.workerEpoch?.runSlotHeld, false);
      assert.equal(normalized.sessionFile, sessionFile);
      assert.equal(restoredWorkers.length, 0, `${stage}: retry does not auto-restore or prompt`);
      assert.equal(restored.mailStore.get(initial.envelope.id)?.deliveryState, "delivered");
      assert.equal(restored.mailStore.get(queued.envelope.id)?.deliveryState, "queued");

      await restored.restart(ADDRESS);
      assert.equal(restoredWorkers.length, 1, `${stage}: explicit same-identity restart creates G+1`);
    } finally {
      await restored.shutdown().catch(() => undefined);
    }
  }
});

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
