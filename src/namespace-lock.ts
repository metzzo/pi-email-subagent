import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { errorMessage, nowIso } from "./util.ts";

const OWNER_FILE = ".broker-owner.json";
export const NAMESPACE_LOCK_STALE_MS = 10_000;
const UPDATE_MS = 2_000;

export interface NamespaceLockHooks {
  afterFilesystemLockAcquired?: () => void | Promise<void>;
  afterFilesystemLockReleased?: () => void | Promise<void>;
}

export interface NamespaceOwner {
  pid: number;
  token: string;
  acquiredAt: string;
  namespaceDir: string;
  bootId?: string;
  processStartTime?: string;
}

export interface KernelProcessIdentity {
  bootId: string;
  processStartTime: string;
}

export async function kernelProcessIdentity(pid: number): Promise<KernelProcessIdentity> {
  if (process.platform !== "linux") {
    throw new Error("safe local namespace ownership requires Linux /proc boot-ID and process-start fencing");
  }
  const [bootId, processStat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
  ]);
  const close = processStat.lastIndexOf(")");
  if (close < 0) throw new Error(`could not parse /proc/${pid}/stat`);
  const fieldsAfterCommand = processStat.slice(close + 1).trim().split(/\s+/);
  const processStartTime = fieldsAfterCommand[19]; // field 22; field 3 is index 0 here
  if (!processStartTime || !/^\d+$/.test(processStartTime)) {
    throw new Error(`could not parse process start time from /proc/${pid}/stat`);
  }
  return { bootId: bootId.trim(), processStartTime };
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function restrictMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (process.platform === "linux") throw error;
  }
}

async function exactOwnerStillLive(owner: NamespaceOwner & Required<Pick<NamespaceOwner, "bootId" | "processStartTime">>): Promise<boolean> {
  try {
    const current = await kernelProcessIdentity(owner.pid);
    return current.bootId === owner.bootId && current.processStartTime === owner.processStartTime;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // An existing PID whose kernel identity cannot be read is not safe to
    // steal from. A missing PID was handled above.
    try { process.kill(owner.pid, 0); return true; } catch (killError) {
      return (killError as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
}

export function isNamespaceOwner(value: unknown): value is NamespaceOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<NamespaceOwner>;
  return Number.isInteger(owner.pid)
    && (owner.pid ?? 0) > 0
    && typeof owner.token === "string"
    && typeof owner.acquiredAt === "string"
    && typeof owner.namespaceDir === "string";
}

async function readOwner(path: string): Promise<NamespaceOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isNamespaceOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function replaceOwner(path: string, owner: NamespaceOwner): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await restrictMode(temp, 0o600);
    await rename(temp, path);
    await restrictMode(path, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export class NamespaceLock {
  private released = false;

  private constructor(
    readonly namespaceDir: string,
    readonly abandonedOwner: boolean,
    private readonly ownerPath: string,
    private readonly owner: NamespaceOwner,
    private readonly releaseLock: () => Promise<void>,
    private readonly hooks: NamespaceLockHooks,
  ) {}

  static async acquire(
    namespaceDir: string,
    onCompromised: (error: Error) => void,
    hooks: NamespaceLockHooks = {},
  ): Promise<NamespaceLock> {
    await mkdir(namespaceDir, { recursive: true, mode: 0o700 });
    await restrictMode(namespaceDir, 0o700);
    // Serialize owner inspection, dead-owner lock removal, filesystem lock
    // acquisition, and new owner publication. A crashed transition guard is
    // deliberately fail-closed because its lock-generation binding is unknown.
    const transitionGuard = join(namespaceDir, ".broker-owner-transition");
    try {
      await mkdir(transitionGuard, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Subagent namespace owner transition is already in progress or abandoned; recovery fails closed: ${namespaceDir}.`);
      }
      throw error;
    }
    try {
      return await NamespaceLock.acquireUnderTransitionGuard(namespaceDir, onCompromised, hooks);
    } finally {
      await rm(transitionGuard, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private static async acquireUnderTransitionGuard(
    namespaceDir: string,
    onCompromised: (error: Error) => void,
    hooks: NamespaceLockHooks,
  ): Promise<NamespaceLock> {
    const ownerPath = join(namespaceDir, OWNER_FILE);
    const token = randomUUID();
    const [priorOwner, priorOwnerPathExists, priorLockExists] = await Promise.all([
      readOwner(ownerPath),
      pathExists(ownerPath),
      pathExists(`${namespaceDir}.lock`),
    ]);
    let abandonedOwner = false;
    if (priorOwner) {
      if (!priorOwner.bootId || !priorOwner.processStartTime || priorOwner.namespaceDir !== namespaceDir) {
        throw new Error(
          `Subagent namespace owner identity is incomplete or mismatched and recovery fails closed: ${namespaceDir}.`,
        );
      }
      const live = await exactOwnerStillLive(priorOwner as NamespaceOwner & Required<Pick<NamespaceOwner, "bootId" | "processStartTime">>);
      if (live) {
        throw new Error(
          `Subagent namespace is already owned (pid ${priorOwner.pid}, acquired ${priorOwner.acquiredAt}): ${namespaceDir}. `
          + "The kernel still identifies that exact owner process; close or resume it before retrying.",
        );
      }
      // Exact Linux boot/PID/start identity proves this owner generation dead.
      // Its in-process AgentSessions/callbacks are gone, so the stale
      // proper-lockfile directory can be removed under the transition guard.
      abandonedOwner = true;
      await rm(`${namespaceDir}.lock`, { recursive: true, force: true });
    } else if (priorOwnerPathExists || priorLockExists) {
      throw new Error(
        `Subagent namespace ownership is ambiguous and recovery fails closed: ${namespaceDir}. `
        + "An owner sidecar or lock exists without one complete exact owner identity.",
      );
    }

    let releaseLock: (() => Promise<void>) | undefined;
    try {
      releaseLock = await lock(namespaceDir, {
        realpath: true,
        stale: NAMESPACE_LOCK_STALE_MS,
        update: UPDATE_MS,
        retries: 0,
        onCompromised,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
        throw new Error(`Could not lock subagent namespace ${namespaceDir}: ${errorMessage(error)}`, { cause: error });
      }
      const owner = await readOwner(ownerPath);
      const diagnostic = owner
        ? `pid ${owner.pid}, acquired ${owner.acquiredAt}`
        : "owner metadata unavailable";
      throw new Error(
        `Subagent namespace is already owned (${diagnostic}): ${namespaceDir}. Close the other Pi process before retrying.`,
        { cause: error },
      );
    }

    try {
      await hooks.afterFilesystemLockAcquired?.();
    } catch (error) {
      await releaseLock().catch(() => undefined);
      throw error;
    }
    let identity: KernelProcessIdentity | undefined;
    try {
      identity = await kernelProcessIdentity(process.pid);
    } catch (error) {
      if (process.platform === "linux" || abandonedOwner) {
        await releaseLock().catch(() => undefined);
        throw new Error(`Could not establish safe subagent namespace owner fencing: ${errorMessage(error)}`, { cause: error });
      }
    }
    const owner: NamespaceOwner = {
      pid: process.pid,
      token,
      acquiredAt: nowIso(),
      namespaceDir,
      ...(identity ?? {}),
    };
    try {
      await replaceOwner(ownerPath, owner);
      return new NamespaceLock(namespaceDir, abandonedOwner, ownerPath, owner, releaseLock, hooks);
    } catch (error) {
      await releaseLock().catch(() => undefined);
      throw new Error(`Could not persist subagent namespace ownership: ${errorMessage(error)}`, { cause: error });
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    // Release the kernel/filesystem lock first. During the following sidecar
    // gap, contenders still fail closed on this exact live owner. This order
    // prevents an old callback from deleting metadata for a newer lease.
    await this.releaseLock();
    await this.hooks.afterFilesystemLockReleased?.();
    const current = await readOwner(this.ownerPath);
    if (current?.token === this.owner.token) await unlink(this.ownerPath).catch(() => undefined);
    this.released = true;
  }
}
