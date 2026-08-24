import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { NamespaceLock } from "../../src/namespace-lock.ts";

it("excludes a second owner, reports the PID, and releases idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-namespace-lock-"));
  const namespace = join(root, "state");
  await mkdir(namespace, { mode: 0o755 });
  await chmod(namespace, 0o755);
  const first = await NamespaceLock.acquire(namespace, () => undefined);
  assert.equal((await stat(namespace)).mode & 0o777, 0o700);
  await assert.rejects(
    NamespaceLock.acquire(namespace, () => undefined),
    new RegExp(`already owned \\(pid ${process.pid}, acquired`),
  );
  const owner = JSON.parse(await readFile(join(namespace, ".broker-owner.json"), "utf8")) as { pid: number };
  assert.equal(owner.pid, process.pid);
  assert.equal((await stat(join(namespace, ".broker-owner.json"))).mode & 0o777, 0o600);

  await first.release();
  await first.release();
  const replacement = await NamespaceLock.acquire(namespace, () => undefined);
  await replacement.release();
});

it("fails closed on an orphaned lock instead of stealing across an owner-publication gap", {
  skip: process.platform !== "linux" ? "Linux fixture uses kernel owner metadata" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-stale-lock-"));
  const namespace = join(root, "state");
  await mkdir(namespace, { recursive: true });
  await chmod(namespace, 0o755);
  await mkdir(`${namespace}.lock`);
  const ownerPath = join(namespace, ".broker-owner.json");
  await writeFile(ownerPath, JSON.stringify({
    pid: 999_999_999,
    token: "stale-token",
    acquiredAt: "2000-01-01T00:00:00.000Z",
    namespaceDir: namespace,
  }));
  await chmod(ownerPath, 0o644);
  const stale = new Date(Date.now() - 30_000);
  await utimes(`${namespace}.lock`, stale, stale);

  await assert.rejects(
    NamespaceLock.acquire(namespace, () => undefined),
    /orphaned.*fail.*closed|manual.*recovery/i,
  );
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token: string };
  assert.equal(owner.token, "stale-token");
});
