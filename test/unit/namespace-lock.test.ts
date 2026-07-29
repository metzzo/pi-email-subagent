import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { NamespaceLock } from "../../src/namespace-lock.ts";

it("excludes a second owner, reports the PID, and releases idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-namespace-lock-"));
  const namespace = join(root, "state");
  const first = await NamespaceLock.acquire(namespace, () => undefined);
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

it("recovers a proper-lockfile lease after its stale threshold", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-stale-lock-"));
  const namespace = join(root, "state");
  await mkdir(namespace, { recursive: true });
  await mkdir(`${namespace}.lock`);
  await writeFile(join(namespace, ".broker-owner.json"), JSON.stringify({
    pid: 999_999_999,
    token: "stale-token",
    acquiredAt: "2000-01-01T00:00:00.000Z",
    namespaceDir: namespace,
  }));
  const stale = new Date(Date.now() - 30_000);
  await utimes(`${namespace}.lock`, stale, stale);

  const recovered = await NamespaceLock.acquire(namespace, () => undefined);
  const owner = JSON.parse(await readFile(join(namespace, ".broker-owner.json"), "utf8")) as { pid: number; token: string };
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, "stale-token");
  await recovered.release();
});
