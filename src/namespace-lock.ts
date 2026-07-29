import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { errorMessage, nowIso } from "./util.ts";

const OWNER_FILE = ".broker-owner.json";
const STALE_MS = 10_000;
const UPDATE_MS = 2_000;

interface NamespaceOwner {
  pid: number;
  token: string;
  acquiredAt: string;
  namespaceDir: string;
}

function isOwner(value: unknown): value is NamespaceOwner {
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
    return isOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export class NamespaceLock {
  private released = false;

  private constructor(
    readonly namespaceDir: string,
    private readonly ownerPath: string,
    private readonly owner: NamespaceOwner,
    private readonly releaseLock: () => Promise<void>,
  ) {}

  static async acquire(
    namespaceDir: string,
    onCompromised: (error: Error) => void,
  ): Promise<NamespaceLock> {
    await mkdir(namespaceDir, { recursive: true, mode: 0o700 });
    const ownerPath = join(namespaceDir, OWNER_FILE);
    const token = randomUUID();
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      releaseLock = await lock(namespaceDir, {
        realpath: true,
        stale: STALE_MS,
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
        `Subagent namespace is already owned (${diagnostic}): ${namespaceDir}. `
        + `Close the other Pi process or wait ${Math.ceil(STALE_MS / 1_000)} seconds after an abrupt exit before retrying.`,
        { cause: error },
      );
    }

    const owner: NamespaceOwner = {
      pid: process.pid,
      token,
      acquiredAt: nowIso(),
      namespaceDir,
    };
    try {
      await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
      return new NamespaceLock(namespaceDir, ownerPath, owner, releaseLock);
    } catch (error) {
      await releaseLock().catch(() => undefined);
      throw new Error(`Could not persist subagent namespace ownership: ${errorMessage(error)}`, { cause: error });
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const current = await readOwner(this.ownerPath);
    if (current?.token === this.owner.token) await unlink(this.ownerPath).catch(() => undefined);
    await this.releaseLock();
  }
}
