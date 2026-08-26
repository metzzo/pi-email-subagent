import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { NamespaceLock, NAMESPACE_LOCK_STALE_MS } from "../../src/namespace-lock.ts";

function waitForReady(child: ReturnType<typeof spawn>, stderr: () => string): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for lock holder.\n${stderr()}`)), 10_000);
    const finish = (error?: Error, pid?: number): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error); else resolve(pid!);
    };
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString();
      const match = /^READY (\d+)$/m.exec(stdout);
      if (match) finish(undefined, Number(match[1]));
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`Lock holder exited before readiness (code ${code}, signal ${signal}).\n${stderr()}`));
    };
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

it("never steals a stale-mtime namespace lease from a live SIGSTOPed owner", {
  timeout: 30_000,
  skip: process.platform !== "linux" ? "kernel owner fencing requires Linux /proc" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sigstop-lock-"));
  const namespace = join(root, "state");
  const child = spawn(process.execPath, ["--import", "tsx", "test/e2e/helpers/namespace-lock-holder.ts", namespace], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  try {
    const holderPid = await waitForReady(child, () => stderr);
    assert.equal(child.kill("SIGSTOP"), true);
    await new Promise((resolve) => setTimeout(resolve, NAMESPACE_LOCK_STALE_MS + 1_000));
    await assert.rejects(
      NamespaceLock.acquire(namespace, () => undefined),
      new RegExp(`already owned \\(pid ${holderPid}, acquired`),
    );
    const owner = JSON.parse(await readFile(join(namespace, ".broker-owner.json"), "utf8")) as { pid: number; bootId?: string; processStartTime?: string };
    assert.equal(owner.pid, holderPid);
    assert.ok(owner.bootId);
    assert.ok(owner.processStartTime);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGCONT");
      child.kill("SIGKILL");
    }
    await closed.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("automatically reclaims a real orphaned namespace lease after exact-owner SIGKILL", {
  timeout: 15_000,
  skip: process.platform !== "linux" ? "Linux fixture requires /proc owner identity" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sigkill-lock-"));
  const namespace = join(root, "state");
  const child = spawn(process.execPath, ["--import", "tsx", "test/e2e/helpers/namespace-lock-holder.ts", namespace], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  try {
    const holderPid = await waitForReady(child, () => stderr);
    assert.equal(holderPid, child.pid);
    const ownerBefore = JSON.parse(await readFile(join(namespace, ".broker-owner.json"), "utf8")) as { pid: number };
    assert.equal(ownerBefore.pid, holderPid);
    await assert.rejects(NamespaceLock.acquire(namespace, () => undefined), new RegExp(`already owned \\(pid ${holderPid}, acquired`));

    assert.equal(child.kill("SIGKILL"), true);
    const exit = await closed;
    assert.equal(exit.code, null);
    assert.equal(exit.signal, "SIGKILL");
    const replacement = await NamespaceLock.acquire(namespace, () => undefined);
    assert.equal(replacement.abandonedOwner, true);
    const ownerAfter = JSON.parse(await readFile(join(namespace, ".broker-owner.json"), "utf8")) as { pid: number; bootId?: string; processStartTime?: string };
    assert.equal(ownerAfter.pid, process.pid);
    assert.ok(ownerAfter.bootId);
    assert.ok(ownerAfter.processStartTime);
    await replacement.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
