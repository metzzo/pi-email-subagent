import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_MODEL_POLICY, loadConfig, resolveAgentProfile } from "../../src/config.ts";

describe("configuration", () => {
  it("applies exact address over role over defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      defaultEffort: "low",
      roles: { reviewer: { effort: "medium", tools: ["read"] } },
    }));
    await writeFile(join(cwd, ".pi", "subagents.json"), JSON.stringify({
      roles: { reviewer: { effort: "high" } },
      addresses: { "reviewer.audit@gpt-5.4.com": { instructions: "Exact audit instructions." } },
    }));
    const { config, warnings } = loadConfig(agentDir, cwd, true);
    assert.deepEqual(warnings, []);
    const profile = resolveAgentProfile(config, "reviewer.audit@gpt-5.4.com", "reviewer");
    assert.equal(profile.effort, "high");
    assert.deepEqual(profile.tools, ["read", "send_email", "fetch_emails"]);
    assert.equal(profile.instructions, "Exact audit instructions.");
  });

  it("loads bounded sender, queue, and batch controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      maxMailsPerSenderPerMinute: 12,
      maxQueuedMessages: 120,
      maxQueuedBytes: 2_000_000,
      maxBatchMessages: 20,
      maxBatchBytes: 200_000,
      maxRetainedEmails: 5_000,
    }));
    const { config, warnings } = loadConfig(agentDir, root, false);
    assert.deepEqual(warnings, []);
    assert.equal(config.maxMailsPerSenderPerMinute, 12);
    assert.equal(config.maxQueuedMessages, 120);
    assert.equal(config.maxQueuedBytes, 2_000_000);
    assert.equal(config.maxBatchMessages, 20);
    assert.equal(config.maxBatchBytes, 200_000);
    assert.equal(config.maxRetainedEmails, 5_000);
  });

  it("provides bounded queue and sender defaults", () => {
    const config = loadConfig("/nonexistent-agent", "/nonexistent-project", false).config;
    assert.equal(config.maxMailsPerSenderPerMinute, 30);
    assert.equal(config.maxQueuedMessages, 256);
    assert.equal(config.maxQueuedBytes, 4 * 1024 * 1024);
    assert.equal(config.maxBatchMessages, 32);
    assert.equal(config.maxBatchBytes, 512 * 1024);
    assert.equal(config.maxRetainedEmails, 10_000);
  });

  it("discovers project config through the runtime config directory name", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".rebranded-pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(cwd, ".rebranded-pi", "subagents.json"), JSON.stringify({ defaultEffort: "high" }));
    assert.equal(loadConfig(agentDir, cwd, true, ".rebranded-pi").config.defaultEffort, "high");
  });

  it("ignores project config when project is untrusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(cwd, ".pi", "subagents.json"), JSON.stringify({ defaultEffort: "max" }));
    assert.equal(loadConfig(agentDir, cwd, false).config.defaultEffort, "medium");
  });

  it("allows overriding the model selection policy and warns on invalid values", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ modelPolicy: "- Always use `gpt-5.4`." }));
    const loaded = loadConfig(agentDir, root, false);
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.config.modelPolicy, "- Always use `gpt-5.4`.");

    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ modelPolicy: 42 }));
    const invalid = loadConfig(agentDir, root, false);
    assert.equal(invalid.config.modelPolicy, DEFAULT_MODEL_POLICY);
    assert.equal(invalid.warnings.length, 1);
    assert.match(invalid.warnings[0]!, /modelPolicy/);
  });

  it("resolves canSpawn exact-over-role-over-default with warnings for invalid values", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      roles: { scout: { canSpawn: false } },
      addresses: { "scout.privileged@gpt-5.4.com": { canSpawn: true } },
    }));
    const { config, warnings } = loadConfig(agentDir, root, false);
    assert.deepEqual(warnings, []);
    assert.equal(resolveAgentProfile(config, "scout.a@gpt-5.4.com", "scout").canSpawn, false);
    assert.equal(resolveAgentProfile(config, "scout.privileged@gpt-5.4.com", "scout").canSpawn, true);
    assert.equal(resolveAgentProfile(config, "worker.a@gpt-5.4.com", "worker").canSpawn, true);

    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ roles: { scout: { canSpawn: "no" } } }));
    const invalid = loadConfig(agentDir, root, false);
    assert.equal(invalid.config.roles.scout?.canSpawn, undefined);
    assert.equal(invalid.warnings.length, 1);
    assert.match(invalid.warnings[0]!, /canSpawn/);
  });

  it("normalizes valid profile keys and rejects unusable role/address keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      roles: { " Worker ": { canSpawn: false }, "bad.role": { tools: ["write"] } },
      addresses: {
        " Worker.Release@GPT-5.4.COM ": { tools: ["read"] },
        "not-an-address": { tools: ["write"] },
      },
    }));
    const loaded = loadConfig(agentDir, root, false);
    assert.equal(loaded.config.roles.worker?.canSpawn, false);
    assert.deepEqual(loaded.config.addresses["worker.release@gpt-5.4.com"]?.tools, ["read"]);
    assert.equal(loaded.config.roles["bad.role"], undefined);
    assert.equal(loaded.config.addresses["not-an-address"], undefined);
    assert.equal(loaded.warnings.length, 2);
    assert.match(loaded.warnings.join("\n"), /invalid role key/);
    assert.match(loaded.warnings.join("\n"), /invalid address key/);
  });

  it("warns and falls back for invalid values", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "subagents.json"), "{\"maxAgents\": 0, \"defaultEffort\": \"huge\", \"maxBatchBytes\": 1000000}");
    const loaded = loadConfig(agentDir, root, true);
    assert.equal(loaded.config.maxAgents, 8);
    assert.equal(loaded.config.defaultEffort, "medium");
    assert.equal(loaded.config.maxBatchBytes, 512 * 1024);
    assert.equal(loaded.warnings.length, 3);
  });
});
