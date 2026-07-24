import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SdkWorker } from "../../src/sdk-worker.ts";
import type { AgentRecord } from "../../src/types.ts";

it("constructs and disposes an isolated real AgentSession without recursively loading extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-email-sdk-worker-"));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
  const model = runtime.getModel("openai-codex", "gpt-5.4-mini") ?? runtime.getModels()[0];
  assert.ok(model, "expected at least one built-in model");
  const now = new Date().toISOString();
  const record: AgentRecord = {
    address: `scout.sdk-start@${model.id}.com`,
    name: "scout",
    taskSlug: "sdk-start",
    provider: model.provider,
    modelId: model.id,
    effort: "low",
    tools: ["read", "grep", "find", "ls", "not_a_real_tool", "send_email", "fetch_emails"],
    state: "paused",
    createdAt: now,
    updatedAt: now,
    enforcementAttempts: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    activity: [],
  };
  const worker = new SdkWorker(runtime);
  await worker.start({
    record,
    model,
    cwd: root,
    agentDir: root,
    sessionDir: join(root, "sessions"),
    projectTrusted: false,
    systemPrompt: "MAILBOX_SENTINEL: send_email and fetch_emails are required.",
    sendEmail: async () => { throw new Error("not called"); },
    fetchEmails: () => [],
  });
  const snapshot = worker.getSnapshot();
  assert.equal(snapshot.record.state, "idle");
  assert.equal(snapshot.record.modelId, model.id);
  assert.equal(snapshot.record.tools.includes("send_email"), true);
  assert.equal(snapshot.record.tools.includes("fetch_emails"), true);
  assert.equal(snapshot.record.tools.includes("not_a_real_tool"), false);
  assert.equal(snapshot.record.tools.includes("inspect_agent"), false);
  assert.equal(snapshot.record.tools.includes("wait_for_replies"), false);
  assert.equal(snapshot.record.tools.includes("manage_agent"), false);
  assert.equal(snapshot.record.activity.some((item) => item.summary.includes("Unknown tools omitted")), true);
  assert.ok(worker.getSessionFile());
  await worker.dispose();
  assert.equal(worker.getSessionFile(), snapshot.record.sessionFile);
});
