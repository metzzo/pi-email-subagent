import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSubagentAddressShape } from "./address.ts";
import { transitionAbandonedOwnerRecovery } from "./abandoned-owner-recovery.ts";
import { isNamespaceOwner, kernelProcessIdentity, type NamespaceOwner } from "./namespace-lock.ts";
import { MAX_OPERATOR_CLEANUP_EVIDENCE_BYTES, parseRegistry } from "./registry-store.ts";
import { safeErrorSummary } from "./safe-summary.ts";
import type { AgentRecord, BrokerRegistry, OperatorCleanupRecovery } from "./types.ts";
import { byteLength, clone, nowIso } from "./util.ts";

export interface CleanupRecoveryInput {
  address: string;
  workerGeneration: number;
  evidence: string;
}

export interface CleanupRecoveryFacts {
  attachedWorker: boolean;
  provisionalWorker: boolean;
  pendingFactory: boolean;
  cleanupOperationPending: boolean;
  activeTool: boolean;
  activeRunSlot: boolean;
}

export interface CleanupRecoveryTransition {
  record: AgentRecord;
  audit: OperatorCleanupRecovery;
  idempotent: boolean;
}

export interface OfflineCleanupRecoveryInput extends CleanupRecoveryInput {
  confirmed: boolean;
}

export interface OfflineCleanupRecoveryResult {
  audit: OperatorCleanupRecovery;
  backupPath: string;
  idempotent: boolean;
  nextStep: "Run /reload, then explicitly restart or archive the recovered identity as appropriate.";
}

export interface OfflineCleanupRecoveryHooks {
  afterGuardAcquired?: () => void | Promise<void>;
  afterOwnerVerified?: () => void | Promise<void>;
  afterBackupCreated?: () => void | Promise<void>;
  afterRegistryCommitted?: () => void | Promise<void>;
  afterLockRemoved?: () => void | Promise<void>;
  afterOwnerRemoved?: () => void | Promise<void>;
}

const MIN_OPERATOR_EVIDENCE_CHARS = 8;
const OWNER_FILE = ".broker-owner.json";
const RECOVERY_GUARD_FILE = ".cleanup-recovery.guard";

export function sanitizeCleanupRecoveryEvidence(value: string): string {
  if (typeof value !== "string") throw new Error("Operator evidence is required.");
  const trimmed = value.trim();
  if (trimmed.length < MIN_OPERATOR_EVIDENCE_CHARS) {
    throw new Error(`Operator evidence must contain at least ${MIN_OPERATOR_EVIDENCE_CHARS} characters.`);
  }
  if (byteLength(trimmed) > MAX_OPERATOR_CLEANUP_EVIDENCE_BYTES) {
    throw new Error(`Operator evidence exceeds ${MAX_OPERATOR_CLEANUP_EVIDENCE_BYTES} UTF-8 bytes.`);
  }
  // The durable audit stores only the shared bounded/redacted summary. The raw
  // statement never enters registry, Activity, prompts, tool details, or UI.
  return safeErrorSummary(trimmed);
}

function normalizedInput(input: CleanupRecoveryInput): CleanupRecoveryInput {
  const address = parseSubagentAddressShape(input.address).address;
  if (!Number.isSafeInteger(input.workerGeneration) || input.workerGeneration < 1) {
    throw new Error("workerGeneration must be a positive safe integer.");
  }
  return {
    address,
    workerGeneration: input.workerGeneration,
    evidence: sanitizeCleanupRecoveryEvidence(input.evidence),
  };
}

function sameAudit(audit: OperatorCleanupRecovery, input: CleanupRecoveryInput): boolean {
  return audit.workerGeneration === input.workerGeneration && audit.evidence === input.evidence;
}

/**
 * Shared online/offline validator and pure state transition. It never infers
 * quiescence: the human statement is the authority and remains labeled as such.
 */
export function transitionCleanupRecovery(
  source: AgentRecord,
  rawInput: CleanupRecoveryInput,
  facts: CleanupRecoveryFacts,
  releasedAt = nowIso(),
): CleanupRecoveryTransition {
  const input = normalizedInput(rawInput);
  if (source.address !== input.address) throw new Error(`Recovery address does not exactly match ${source.address}.`);

  if (!source.cleanup) {
    if (source.lastCleanupRecovery && sameAudit(source.lastCleanupRecovery, input)) {
      const exactReleasedEpoch = source.workerEpoch?.phase === "operator-released"
        && source.workerEpoch.generation === input.workerGeneration
        && !source.workerEpoch.runSlotHeld;
      const exactInactiveState = source.state === "failed";
      const noLiveState = !facts.attachedWorker
        && !facts.provisionalWorker
        && !facts.pendingFactory
        && !facts.cleanupOperationPending
        && !facts.activeTool
        && !facts.activeRunSlot;
      if (exactReleasedEpoch && exactInactiveState && noLiveState) {
        return { record: clone(source), audit: clone(source.lastCleanupRecovery), idempotent: true };
      }
      throw new Error(
        `Stale cleanup recovery retry for generation ${input.workerGeneration}: the current epoch is ${source.workerEpoch?.phase ?? "missing"} generation ${source.workerEpoch?.generation ?? "missing"}, not the same inactive operator-released epoch.`,
      );
    }
    if (source.lastCleanupRecovery) {
      throw new Error(`Cleanup generation ${source.lastCleanupRecovery.workerGeneration} was already operator-released with a different exact audit; refusing a conflicting retry.`);
    }
    throw new Error(`Agent ${source.address} has no cleanup quarantine to recover.`);
  }

  if (source.lastCleanupRecovery?.workerGeneration === input.workerGeneration) {
    if (source.workerEpoch?.generation !== input.workerGeneration || source.workerEpoch.phase !== "operator-released") {
      throw new Error(
        `Stale cleanup recovery retry for generation ${input.workerGeneration}: current epoch is ${source.workerEpoch?.phase ?? "missing"} generation ${source.workerEpoch?.generation ?? "missing"}.`,
      );
    }
    throw new Error(`Cleanup generation ${input.workerGeneration} has both a quarantine and an existing recovery audit; registry state is incoherent.`);
  }
  if (facts.attachedWorker) throw new Error("Cleanup recovery requires no attached or live worker.");
  if (facts.provisionalWorker) throw new Error("Cleanup recovery requires no provisional worker.");
  if (facts.pendingFactory) throw new Error("Cleanup recovery rejects a pending worker factory.");
  if (facts.cleanupOperationPending) throw new Error("Cleanup recovery rejects a live or pending cleanup operation.");
  if (facts.activeTool || source.cleanup.activeTools.length > 0) throw new Error("Cleanup recovery rejects an active tool receipt.");
  if (facts.activeRunSlot || source.cleanup.heldRunSlot || source.workerEpoch?.runSlotHeld) {
    throw new Error("Cleanup recovery rejects an active or held run slot.");
  }
  if (source.cleanup.state !== "unknown"
    || source.cleanup.abort === "pending"
    || source.cleanup.dispose === "pending") {
    throw new Error("Cleanup recovery allows only a settled persisted unknown cleanup, never pending cleanup.");
  }
  if (source.cleanup.workerGeneration !== input.workerGeneration) {
    throw new Error(`Cleanup generation mismatch: record is ${source.cleanup.workerGeneration}, request is ${input.workerGeneration}.`);
  }
  if (!source.workerEpoch || source.workerEpoch.generation !== input.workerGeneration) {
    throw new Error("Cleanup recovery requires an exact matching durable worker epoch generation.");
  }
  if (source.workerEpoch.phase !== "activated") {
    throw new Error(`Cleanup recovery rejects worker epoch phase ${source.workerEpoch.phase}.`);
  }
  if (source.state !== "failed" && source.state !== "paused") {
    throw new Error("Cleanup recovery requires an inactive failed or paused identity.");
  }

  const audit: OperatorCleanupRecovery = {
    workerGeneration: input.workerGeneration,
    releasedAt,
    evidence: input.evidence,
    source: "operator-attested",
  };
  const record = clone(source);
  delete record.cleanup;
  record.lastCleanupRecovery = audit;
  record.workerEpoch = { ...record.workerEpoch!, phase: "operator-released", runSlotHeld: false };
  record.state = "failed";
  record.failure = `Cleanup quarantine operator-released for worker generation ${input.workerGeneration} by operator attestation; Pi did not verify quiescence. Explicit restart or archive is required.`;
  record.currentActivity = `Cleanup operator-released for generation ${input.workerGeneration}; Pi did not verify quiescence`;
  record.updatedAt = releasedAt;
  record.activity.push({ at: releasedAt, kind: "status", summary: record.currentActivity });
  record.activity = record.activity.slice(-40);
  return { record, audit, idempotent: false };
}

function strictOwner(value: unknown, namespaceDir: string): NamespaceOwner {
  if (!isNamespaceOwner(value)
    || value.namespaceDir !== namespaceDir
    || typeof value.bootId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.bootId)
    || typeof value.processStartTime !== "string"
    || !/^[1-9]\d*$/.test(value.processStartTime)
    || value.token.length === 0
    || value.token.length > 200
    || !Number.isFinite(Date.parse(value.acquiredAt))) {
    throw new Error("Namespace owner identity is malformed or missing exact Linux boot-ID/process-start fields.");
  }
  return value;
}

async function readStrictOwner(ownerPath: string, namespaceDir: string): Promise<{ owner: NamespaceOwner; raw: string }> {
  let raw: string;
  try {
    raw = await readFile(ownerPath, "utf8");
  } catch (error) {
    throw new Error("Namespace owner identity is missing; offline cleanup recovery fails closed.", { cause: error });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error("Namespace owner identity is malformed; offline cleanup recovery fails closed.", { cause: error });
  }
  return { owner: strictOwner(parsed, namespaceDir), raw };
}

async function exactOwnerLive(owner: NamespaceOwner): Promise<boolean> {
  if (process.platform !== "linux") throw new Error("Offline cleanup recovery requires Linux boot-ID and /proc process-start verification.");
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (owner.bootId !== bootId) return false;
  try {
    const current = await kernelProcessIdentity(owner.pid);
    return current.bootId === owner.bootId && current.processStartTime === owner.processStartTime;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("The recorded namespace owner cannot be verified absent; recovery fails closed.", { cause: error });
  }
}

async function readUnchanged(path: string, expected: string, label: string): Promise<void> {
  let current: string;
  try { current = await readFile(path, "utf8"); } catch (error) {
    throw new Error(`${label} disappeared during recovery; possible race, failing closed.`, { cause: error });
  }
  if (current !== expected) throw new Error(`${label} changed during recovery; possible race, failing closed.`);
}

async function lockArtifactIsDirectory(path: string): Promise<boolean> {
  try {
    const value = await lstat(path);
    if (!value.isDirectory()) throw new Error("Namespace lock artifact is malformed; recovery fails closed.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicRegistryRewrite(path: string, registry: BrokerRegistry): Promise<void> {
  const snapshot = parseRegistry(registry);
  const temp = `${path}.${process.pid}.${randomUUID()}.cleanup-recovery.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function acquireRecoveryGuard(path: string, namespaceDir: string): Promise<string> {
  const identity = await kernelProcessIdentity(process.pid);
  const owner: NamespaceOwner = {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: nowIso(),
    namespaceDir,
    ...identity,
  };
  const raw = `${JSON.stringify(owner, null, 2)}\n`;
  try {
    await writeFile(path, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      "The fixed .cleanup-recovery.guard already exists; recovery fails closed without reading, replacing, or reclaiming it. Inspect its exact PID, Linux boot ID, and process-start identity; inspect the registry and backups for the crash stage; only after proving that guard owner dead, deliberately remove that one guard and retry.",
      { cause: error },
    );
  }
}

async function releaseGuard(path: string, expectedRaw: string): Promise<void> {
  try {
    if (await readFile(path, "utf8") === expectedRaw) await unlink(path);
  } catch { /* retain an uncertain/replaced guard rather than deleting it */ }
}

/** Manual startup-blocked recovery. This never starts a broker or reloads Pi. */
export async function recoverOrphanedCleanup(
  namespaceDir: string,
  rawInput: OfflineCleanupRecoveryInput,
  hooks: OfflineCleanupRecoveryHooks = {},
): Promise<OfflineCleanupRecoveryResult> {
  if (!rawInput.confirmed) throw new Error("Offline cleanup recovery requires the explicit --confirm authorization.");
  if (process.platform !== "linux") throw new Error("Offline cleanup recovery requires Linux boot-ID and /proc process-start verification.");
  const input = normalizedInput(rawInput);
  const guardPath = join(namespaceDir, RECOVERY_GUARD_FILE);
  const guardRaw = await acquireRecoveryGuard(guardPath, namespaceDir);

  try {
    await hooks.afterGuardAcquired?.();
    const ownerPath = join(namespaceDir, OWNER_FILE);
    const registryPath = join(namespaceDir, "registry.json");
    const lockPath = `${namespaceDir}.lock`;
    const ownerSnapshot = await readStrictOwner(ownerPath, namespaceDir);
    if (await exactOwnerLive(ownerSnapshot.owner)) {
      throw new Error(`Recorded namespace owner pid ${ownerSnapshot.owner.pid} is still live (including SIGSTOP); exit that exact owner normally before recovery.`);
    }
    const lockExists = await lockArtifactIsDirectory(lockPath);
    await hooks.afterOwnerVerified?.();

    let registryRaw: string;
    try { registryRaw = await readFile(registryPath, "utf8"); } catch (error) {
      throw new Error("Canonical registry is missing or unreadable; recovery fails closed.", { cause: error });
    }
    let registry: BrokerRegistry;
    try { registry = parseRegistry(JSON.parse(registryRaw)); } catch (error) {
      throw new Error("Canonical registry is malformed; recovery fails closed.", { cause: error });
    }
    const abandonedAt = nowIso();
    registry.agents = registry.agents.map((record) => transitionAbandonedOwnerRecovery(record, abandonedAt).record);
    const index = registry.agents.findIndex((record) => record.address === input.address);
    if (index < 0) throw new Error(`Unknown exact recovery address ${input.address}.`);
    const transition = transitionCleanupRecovery(registry.agents[index]!, input, {
      attachedWorker: false,
      provisionalWorker: false,
      pendingFactory: registry.agents[index]!.workerEpoch?.phase === "spawning",
      cleanupOperationPending: registry.agents[index]!.cleanup?.state === "pending"
        || registry.agents[index]!.cleanup?.abort === "pending"
        || registry.agents[index]!.cleanup?.dispose === "pending",
      activeTool: Boolean(registry.agents[index]!.cleanup?.activeTools.length),
      activeRunSlot: Boolean(registry.agents[index]!.cleanup?.heldRunSlot || registry.agents[index]!.workerEpoch?.runSlotHeld),
    });
    registry.agents[index] = transition.record;
    registry.updatedAt = transition.audit.releasedAt;

    await readUnchanged(ownerPath, ownerSnapshot.raw, "Namespace owner identity");
    await readUnchanged(registryPath, registryRaw, "Canonical registry");
    const backupPath = join(namespaceDir, `registry.json.cleanup-recovery-${Date.now()}-${randomUUID()}.bak`);
    await writeFile(backupPath, registryRaw, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(backupPath, 0o600);
    await hooks.afterBackupCreated?.();

    // The backup is the final pre-commit boundary. Any owner/registry race
    // aborts before the canonical atomic rename.
    await readUnchanged(ownerPath, ownerSnapshot.raw, "Namespace owner identity");
    await readUnchanged(registryPath, registryRaw, "Canonical registry");
    if (await exactOwnerLive(ownerSnapshot.owner)) {
      throw new Error("Recorded namespace owner became live during recovery; possible race, failing closed.");
    }
    await atomicRegistryRewrite(registryPath, registry);
    await hooks.afterRegistryCommitted?.();

    // Remove the lock directory before its owner sidecar. If this phase fails,
    // the retained exact identity permits a safe idempotent retry.
    if (lockExists) {
      if (!await lockArtifactIsDirectory(lockPath)) throw new Error("Namespace lock artifact disappeared during recovery; possible race, failing closed.");
      await rmdir(lockPath);
    }
    await hooks.afterLockRemoved?.();
    await readUnchanged(ownerPath, ownerSnapshot.raw, "Namespace owner identity");
    await unlink(ownerPath);
    await hooks.afterOwnerRemoved?.();

    return {
      audit: transition.audit,
      backupPath,
      idempotent: transition.idempotent,
      nextStep: "Run /reload, then explicitly restart or archive the recovered identity as appropriate.",
    };
  } finally {
    await releaseGuard(guardPath, guardRaw);
  }
}

export interface OnlineCleanupRecoveryBroker {
  recoverCleanup(address: string, workerGeneration: number, evidence: string): Promise<OperatorCleanupRecovery>;
}

export interface CleanupRecoveryCommandResult {
  audit: OperatorCleanupRecovery;
  offline: boolean;
  nextStep?: OfflineCleanupRecoveryResult["nextStep"];
}

/** The single human command boundary shared by online and startup-blocked use. */
export async function executeCleanupRecoveryCommand(
  args: string,
  broker: OnlineCleanupRecoveryBroker | undefined,
  namespaceDir: string,
): Promise<CleanupRecoveryCommandResult> {
  const recovery = parseCleanupRecoveryCommand(args);
  if (broker) {
    return {
      audit: await broker.recoverCleanup(recovery.address, recovery.workerGeneration, recovery.evidence),
      offline: false,
    };
  }
  const result = await recoverOrphanedCleanup(namespaceDir, recovery);
  return { audit: result.audit, offline: true, nextStep: result.nextStep };
}

export function parseCleanupRecoveryCommand(args: string): OfflineCleanupRecoveryInput {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts[0] !== "recover-cleanup" || !parts[1] || !parts[2] || parts[3] !== "--confirm" || parts.length < 5) {
    throw new Error("Usage: /agents recover-cleanup <exact-address> <worker-generation> --confirm <operator evidence>");
  }
  if (!/^\d+$/.test(parts[2])) throw new Error("worker-generation must be a positive integer.");
  return {
    address: parts[1],
    workerGeneration: Number(parts[2]),
    confirmed: true,
    evidence: parts.slice(4).join(" "),
  };
}
