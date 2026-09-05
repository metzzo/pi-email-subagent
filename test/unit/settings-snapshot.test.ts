import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { WorkerSettingsSnapshot } from "../../src/settings-snapshot.ts";

it("keeps explicit Pi settings writes worker-local and leaves the captured snapshot unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-settings-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const globalText = JSON.stringify({ defaultThinkingLevel: "low", steeringMode: "all", packages: ["npm:never-install"] });
  const projectText = JSON.stringify({ followUpMode: "all", extensions: ["never-load.ts"] });
  await writeFile(globalPath, globalText);
  await writeFile(projectPath, projectText);

  const snapshot = WorkerSettingsSnapshot.capture(cwd, agentDir, true);
  assert.deepEqual(snapshot.loadIssues, []);
  const first = snapshot.createManager("low");
  const second = snapshot.createManager("high");
  assert.notEqual(first, second);
  assert.equal(first.getSteeringMode(), "all");
  assert.equal(first.getFollowUpMode(), "all");
  assert.deepEqual(first.getPackages(), []);
  assert.deepEqual(first.getExtensionPaths(), []);

  // Pi 0.85.0 session model/thinking setters no longer persist by default.
  // Explicit SettingsManager writes must still stay inside each worker.
  first.setDefaultThinkingLevel("high");
  first.setSteeringMode("one-at-a-time");
  first.setFollowUpMode("one-at-a-time");
  await first.flush();
  assert.deepEqual(first.drainErrors(), []);
  assert.equal(first.getDefaultThinkingLevel(), "high");
  assert.equal(second.getDefaultThinkingLevel(), "low");
  assert.equal(second.getSteeringMode(), "all");
  assert.equal(snapshot.createManager("low").getSteeringMode(), "all");
  assert.equal(await readFile(globalPath, "utf8"), globalText);
  assert.equal(await readFile(projectPath, "utf8"), projectText);
});
