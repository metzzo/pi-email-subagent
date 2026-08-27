import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function secondOperationEnteredWhileFirstWasHeld(
  firstPath: string,
  secondPath: string,
  observationMs = 2_000,
): Promise<boolean> {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const secondEntered = deferred();
  const first = withFileMutationQueue(firstPath, async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  });
  await firstEntered.promise;
  const second = withFileMutationQueue(secondPath, async () => { secondEntered.resolve(); });
  const enteredBeforeRelease = await Promise.race([
    secondEntered.promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), observationMs)),
  ]);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  return enteredBeforeRelease;
}

describe("Pi 0.84.2 containment dependency characterization", { concurrency: false }, () => {
  it("serializes two operations using the same direct mutation path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mutation-queue-same-path-"));
    try {
      const target = join(root, "target.txt");
      await writeFile(target, "fixture\n");
      assert.equal(await secondOperationEnteredWhileFirstWasHeld(target, target, 250), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("observes the missing-target symlink-alias queue-key gap", {
    skip: process.platform === "win32" ? "this dependency characterization uses a POSIX directory symlink" : false,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mutation-queue-missing-alias-"));
    try {
      const real = join(root, "real");
      const alias = join(root, "alias");
      await mkdir(real);
      await symlink(real, alias);
      assert.equal(
        await secondOperationEnteredWhileFirstWasHeld(join(real, "missing.txt"), join(alias, "missing.txt")),
        true,
        "Pi 0.84.2 does not serialize missing targets whose symlinked ancestors converge",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("observes the existing hard-link alias queue-key gap", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mutation-queue-hard-link-"));
    try {
      const target = join(root, "target.txt");
      const alias = join(root, "alias.txt");
      await writeFile(target, "fixture\n");
      await link(target, alias);
      assert.equal(
        await secondOperationEnteredWhileFirstWasHeld(target, alias),
        true,
        "Pi 0.84.2 does not serialize two existing pathnames for the same hard-linked inode",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
