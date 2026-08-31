import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

const releaseScript = resolve("scripts/release-evidence.ts");
const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(): Promise<{ root: string; initial: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-email-release-evidence-"));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Release Evidence Test");
  git(root, "config", "user.email", "release-evidence@example.invalid");
  await writeFile(join(root, "tracked.txt"), "initial\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  const initial = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", initial);
  return { root, initial };
}

function evidence(root: string, base: string) {
  return spawnSync(process.execPath, [tsxCli, releaseScript, base, "HEAD", join(root, "evidence")], {
    cwd: root,
    encoding: "utf8",
  });
}

it("release evidence rejects dirty tracked, untracked, and indexed changes before artifact generation", async () => {
  for (const state of ["tracked", "untracked", "index"] as const) {
    const { root, initial } = await repository();
    try {
      if (state === "tracked") await appendFile(join(root, "tracked.txt"), "dirty\n");
      if (state === "untracked") await writeFile(join(root, "untracked.txt"), "dirty\n");
      if (state === "index") {
        await appendFile(join(root, "tracked.txt"), "indexed\n");
        git(root, "add", "tracked.txt");
      }
      const result = evidence(root, initial);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /requires a clean worktree and index/);
      assert.equal(existsSync(join(root, "evidence")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

it("release evidence rejects a candidate divergent from origin/main before artifact generation", async () => {
  const { root, initial } = await repository();
  try {
    await appendFile(join(root, "tracked.txt"), "local commit\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "local only");
    const result = evidence(root, initial);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is not pushed origin\/main/);
    assert.equal(existsSync(join(root, "evidence")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
