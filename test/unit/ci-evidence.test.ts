import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

it("CI surfaces the full redirected test report without changing validation or uploading session data", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /- run: npm run validate\n/);
  const report = workflow.match(/- name: Surface the redirected test report on failure\n        if: failure\(\)\n        run: \|\n([\s\S]*?)(?=      - name:)/)![1]!.replace(/^          /gm, "");
  const root = await mkdtemp(join(tmpdir(), "ci-evidence-"));
  try {
    const missing = spawnSync("bash", ["-e", "-c", report], { cwd: root, encoding: "utf8" });
    assert.equal(missing.status, 0);
    assert.match(missing.stdout, /No coverage test report was produced/);
    await mkdir(join(root, ".test-workspaces"));
    const contents = "first diagnostic\n" + "preserved diagnostic\n".repeat(3_000) + "last diagnostic\n";
    await writeFile(join(root, ".test-workspaces/coverage-tests.log"), contents);
    const present = spawnSync("bash", ["-e", "-c", report], { cwd: root, encoding: "utf8" });
    assert.equal(present.status, 0);
    assert.equal(present.stdout, contents);
  } finally { await rm(root, { recursive: true, force: true }); }
  const artifact = workflow.match(/- name: Retain deterministic test and coverage reports\n([\s\S]*?)(?=      # Pi core)/)![1]!;
  assert.match(artifact, /if: always\(\)/);
  assert.match(artifact, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(artifact, /include-hidden-files: true/);
  assert.deepEqual(artifact.split("path: |\n")[1]!.trim().split(/\s+/), [
    ".test-workspaces/coverage-tests.log", ".test-workspaces/coverage-raw.lcov", ".test-workspaces/coverage.lcov",
  ]);
});
