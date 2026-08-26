import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { NamespaceLock } from "../../src/namespace-lock.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

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

it("blocks contenders on both controlled owner-publication and release gaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-lock-barriers-"));
  const namespace = join(root, "state");
  const acquired = deferred();
  const publish = deferred();
  const acquiring = NamespaceLock.acquire(namespace, () => undefined, {
    afterFilesystemLockAcquired: async () => { acquired.resolve(); await publish.promise; },
  });
  await acquired.promise;
  await assert.rejects(NamespaceLock.acquire(namespace, () => undefined), /owner transition.*in progress.*fails closed/i);
  publish.resolve();
  const first = await acquiring;

  const released = deferred();
  const removeSidecar = deferred();
  const internal = first as unknown as { hooks: { afterFilesystemLockReleased?: () => Promise<void> } };
  internal.hooks.afterFilesystemLockReleased = async () => { released.resolve(); await removeSidecar.promise; };
  const releasing = first.release();
  await released.promise;
  await assert.rejects(NamespaceLock.acquire(namespace, () => undefined), /already owned.*pid/i);
  removeSidecar.resolve();
  await releasing;
  const next = await NamespaceLock.acquire(namespace, () => undefined);
  await next.release();
});

it("fails closed on malformed owner metadata even without a lock directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-malformed-owner-"));
  const namespace = join(root, "state");
  await mkdir(namespace, { recursive: true });
  const ownerPath = join(namespace, ".broker-owner.json");
  await writeFile(ownerPath, "{malformed\n");
  await assert.rejects(NamespaceLock.acquire(namespace, () => undefined), /ownership is ambiguous.*fails closed/i);
  assert.equal(await readFile(ownerPath, "utf8"), "{malformed\n");
});

it("rejects truthy malformed exact-owner identity fields without changing the owner or lock", {
  skip: process.platform !== "linux" ? "Linux fixture uses kernel owner metadata" : false,
}, async () => {
  const malformedOwners = [
    { label: "boot ID", bootId: "truthy-not-a-uuid" },
    { label: "process start", processStartTime: "1e3" },
    { label: "token bound", token: "x".repeat(201) },
    { label: "timestamp bound", acquiredAt: `2026-09-01T00:00:00.000Z${"x".repeat(200)}` },
  ];
  for (const malformed of malformedOwners) {
    const root = await mkdtemp(join(tmpdir(), "pi-email-malformed-exact-owner-"));
    const namespace = join(root, "state");
    await mkdir(namespace, { recursive: true });
    const ownerPath = join(namespace, ".broker-owner.json");
    const owner = {
      pid: 999_999_999,
      token: "bounded-token",
      acquiredAt: "2026-09-01T00:00:00.000Z",
      namespaceDir: namespace,
      bootId: "00000000-0000-0000-0000-000000000001",
      processStartTime: "1",
      ...malformed,
    };
    const bytes = `${JSON.stringify(owner, null, 2)}\n`;
    await writeFile(ownerPath, bytes);
    await mkdir(`${namespace}.lock`);
    const lockBefore = await stat(`${namespace}.lock`);

    let acquired: NamespaceLock | undefined;
    let acquisitionError: unknown;
    try {
      acquired = await NamespaceLock.acquire(namespace, () => undefined);
    } catch (error) {
      acquisitionError = error;
    }
    try {
      assert.match(String(acquisitionError), /incomplete|malformed|ambiguous|fails closed/i, malformed.label);
      assert.equal(await readFile(ownerPath, "utf8"), bytes, `${malformed.label} owner bytes`);
      assert.equal((await stat(`${namespace}.lock`)).ino, lockBefore.ino, `${malformed.label} lock identity`);
    } finally {
      await acquired?.release();
    }
  }
});

it("fails closed on an orphaned lock with no complete exact owner identity", {
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
    /identity is incomplete|ownership is ambiguous.*fails closed/i,
  );
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token: string };
  assert.equal(owner.token, "stale-token");
});
