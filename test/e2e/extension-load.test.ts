import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { it } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

it("loads the packaged extension with tools, command, and renderers and no conflicts", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-email-extension-load-"));
  const result = await discoverAndLoadExtensions([resolve("src/index.ts")], process.cwd(), agentDir);
  assert.deepEqual(result.errors, []);
  const extension = result.extensions.find((item) => item.tools.has("send_email"));
  assert.ok(extension, "expected the pi-email-subagent extension");
  assert.deepEqual([...extension.tools.keys()].sort(), [
    "fetch_emails",
    "inspect_agent",
    "manage_agent",
    "send_email",
    "wait_for_replies",
  ]);
  assert.equal(extension.commands.has("agents"), true);
  assert.equal(extension.shortcuts.size, 1);
  assert.equal(extension.messageRenderers.has("pi-email-subagent.email"), true);
  assert.equal(extension.messageRenderers.has("pi-email-subagent.alert"), true);
});
