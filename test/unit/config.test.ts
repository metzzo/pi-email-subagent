import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_MODEL_POLICY,
  loadConfig,
  MAX_CONFIG_ADDRESS_ENTRIES,
  MAX_CONFIG_INSTRUCTIONS_BYTES,
  MAX_CONFIG_MODEL_POLICY_BYTES,
  MAX_CONFIG_PROFILE_TOOLS,
  MAX_CONFIG_ROLE_ENTRIES,
  MAX_CONFIG_TOOL_NAME_BYTES,
  MAX_CONFIG_WARNINGS,
  MAX_TIMER_DELAY_MS,
  resolveAgentProfile,
  resolveLifecycle,
} from "../../src/config.ts";

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
    assert.equal(resolveAgentProfile(config, "worker.a@gpt-5.4.com", "worker").canSpawn, false);
    assert.equal(resolveAgentProfile(config, "analyst.a@gpt-5.4.com", "analyst").canSpawn, false);

    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ roles: { scout: { canSpawn: "no" } } }));
    const invalid = loadConfig(agentDir, root, false);
    assert.equal(invalid.config.roles.scout?.canSpawn, false);
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

  it("resolves lifecycle field-by-field and enforces administrative maxima", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      lifecycle: { runTimeoutMs: 1000, idleTimeoutMs: 900 },
      lifecycleMaxima: { runTimeoutMs: 5000 },
      roles: { worker: { lifecycle: { runTimeoutMs: 2000, idleTimeoutMs: 800 } } },
      addresses: { "worker.a@gpt-5.4.com": { lifecycle: { runTimeoutMs: 3000 } } },
    }));
    const { config, warnings } = loadConfig(agentDir, root, false);
    assert.deepEqual(warnings, []);
    const resolved = resolveLifecycle(config, "worker.a@gpt-5.4.com", "worker", { idleTimeoutMs: 700 });
    assert.equal(resolved.runTimeoutMs, 3000);
    assert.equal(resolved.idleTimeoutMs, 700);
    assert.ok(Object.values(resolved).every((value) => Number.isInteger(value) && value > 0));
    assert.throws(() => resolveLifecycle(config, "worker.a@gpt-5.4.com", "worker", { runTimeoutMs: 5001 }), /administrative maximum 5000/);
  });

  it("keeps broker shutdown global and ignores role attempts to override it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      lifecycle: { brokerShutdownTimeoutMs: 1234 },
      roles: { worker: { lifecycle: { brokerShutdownTimeoutMs: 2 } } },
    }));
    const loaded = loadConfig(agentDir, root, false);
    assert.equal(resolveLifecycle(loaded.config, "worker.a@gpt-5.4.com", "worker").brokerShutdownTimeoutMs, 1234);
    assert.equal(loaded.config.roles.worker?.lifecycle?.brokerShutdownTimeoutMs, undefined);
    assert.match(loaded.warnings.join("\n"), /global administrator-only/);
  });

  it("rejects lifecycle delays above the runtime-safe timer maximum everywhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const oversized = MAX_TIMER_DELAY_MS + 1;
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      lifecycle: { runTimeoutMs: oversized },
      lifecycleMaxima: { idleTimeoutMs: oversized },
      roles: { worker: { lifecycle: { abortTimeoutMs: oversized } } },
    }));
    const loaded = loadConfig(agentDir, root, false);
    assert.equal(loaded.config.lifecycle.runTimeoutMs, 4 * 60 * 60_000);
    assert.equal(loaded.config.lifecycleMaxima.idleTimeoutMs, 4 * 60 * 60_000);
    assert.equal(loaded.config.roles.worker?.lifecycle?.abortTimeoutMs, undefined);
    assert.equal(loaded.warnings.filter((warning) => warning.includes("runtime-safe timer maximum")).length, 3);
    assert.throws(
      () => resolveLifecycle(loaded.config, "worker.a@gpt-5.4.com", "worker", { runTimeoutMs: oversized }),
      /runtime-safe timer maximum/,
    );
  });

  it("warns on invalid lifecycle fields and keeps finite defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ lifecycle: { runTimeoutMs: 0, unknown: 1 } }));
    const loaded = loadConfig(agentDir, root, false);
    assert.equal(loaded.config.lifecycle.runTimeoutMs > 0, true);
    assert.match(loaded.warnings.join("\n"), /runTimeoutMs.*integer from 1/);
    assert.match(loaded.warnings.join("\n"), /unknown/);
  });

  it("rejects role/address collections beyond their canonical entry bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const roles = Object.fromEntries(Array.from(
      { length: MAX_CONFIG_ROLE_ENTRIES + 1 },
      (_, index) => [`custom-${index}`, { tools: ["read"] }],
    ));
    const addresses = Object.fromEntries(Array.from(
      { length: MAX_CONFIG_ADDRESS_ENTRIES + 1 },
      (_, index) => [`worker.task-${index}@gpt-5.4.com`, { tools: ["read"] }],
    ));
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ roles, addresses }));
    const loaded = loadConfig(agentDir, root, false);
    assert.deepEqual(Object.keys(loaded.config.roles).sort(), Object.keys(loadConfig("/missing", root, false).config.roles).sort());
    assert.deepEqual(loaded.config.addresses, {});
    assert.match(loaded.warnings.join("\n"), new RegExp(`roles.*at most ${MAX_CONFIG_ROLE_ENTRIES} source properties before canonicalization`, "i"));
    assert.match(loaded.warnings.join("\n"), new RegExp(`addresses.*at most ${MAX_CONFIG_ADDRESS_ENTRIES} source properties before canonicalization`, "i"));
  });

  it("rejects oversized semantic fields without truncation or raw rejected content", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const instructionSentinel = `INSTRUCTION_SENTINEL_${"🙂".repeat(MAX_CONFIG_INSTRUCTIONS_BYTES)}`;
    const policySentinel = `POLICY_SENTINEL_${"é".repeat(MAX_CONFIG_MODEL_POLICY_BYTES)}`;
    const toolSentinel = `TOOL_SENTINEL_${"é".repeat(MAX_CONFIG_TOOL_NAME_BYTES)}`;
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      modelPolicy: policySentinel,
      roles: {
        semantic: {
          tools: [toolSentinel],
          instructions: instructionSentinel,
        },
        many: { tools: Array.from({ length: MAX_CONFIG_PROFILE_TOOLS + 1 }, (_, index) => `tool-${index}`) },
      },
    }));
    const loaded = loadConfig(agentDir, root, false);
    assert.equal(loaded.config.modelPolicy, DEFAULT_MODEL_POLICY);
    assert.equal(loaded.config.roles.semantic?.instructions, undefined);
    assert.equal(loaded.config.roles.semantic?.tools, undefined);
    assert.equal(loaded.config.roles.many?.tools, undefined);
    assert.equal(resolveAgentProfile(loaded.config, "semantic.task@gpt-5.4.com", "semantic").tools.includes("fetch_emails"), true);
    const warnings = loaded.warnings.join("\n");
    assert.match(warnings, /modelPolicy.*UTF-8 bytes/i);
    assert.match(warnings, /instructions.*UTF-8 bytes/i);
    assert.match(warnings, /tools.*unique names/i);
    assert.doesNotMatch(warnings, /INSTRUCTION_SENTINEL|POLICY_SENTINEL|TOOL_SENTINEL/);
  });

  it("accepts exact multibyte semantic limits and rejects the next complete value", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const exactInstructions = "é".repeat(MAX_CONFIG_INSTRUCTIONS_BYTES / 2);
    const exactPolicy = "é".repeat(MAX_CONFIG_MODEL_POLICY_BYTES / 2);
    const exactTool = "é".repeat(MAX_CONFIG_TOOL_NAME_BYTES / 2);
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      modelPolicy: exactPolicy,
      roles: { exact: { tools: [exactTool], instructions: exactInstructions } },
    }));
    const exact = loadConfig(agentDir, root, false);
    assert.equal(exact.config.modelPolicy, exactPolicy);
    assert.equal(exact.config.roles.exact?.instructions, exactInstructions);
    assert.deepEqual(exact.config.roles.exact?.tools, [exactTool]);

    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      modelPolicy: `${exactPolicy}é`,
      roles: { exact: { tools: [`${exactTool}é`], instructions: `${exactInstructions}é` } },
    }));
    const over = loadConfig(agentDir, root, false);
    assert.equal(over.config.modelPolicy, DEFAULT_MODEL_POLICY);
    assert.equal(over.config.roles.exact?.instructions, undefined);
    assert.equal(over.config.roles.exact?.tools, undefined);
  });

  it("rejects control and bidi characters in semantic config without echoing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const sentinel = "HIDDEN\u202eVALUE\u0007";
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({
      modelPolicy: `policy ${sentinel}`,
      roles: { unsafe: { tools: [`tool-${sentinel}`], instructions: `instruction ${sentinel}` } },
    }));
    const loaded = loadConfig(agentDir, root, false);
    assert.equal(loaded.config.modelPolicy, DEFAULT_MODEL_POLICY);
    assert.equal(loaded.config.roles.unsafe?.tools, undefined);
    assert.equal(loaded.config.roles.unsafe?.instructions, undefined);
    assert.match(loaded.warnings.join("\n"), /control or bidirectional-control/i);
    assert.doesNotMatch(loaded.warnings.join("\n"), /HIDDEN|VALUE|\u202e|\u0007/);
  });

  it("bounds deterministic configuration warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-config-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const roles = Object.fromEntries(Array.from({ length: MAX_CONFIG_ROLE_ENTRIES }, (_, index) => [
      `invalid-${index}`,
      { effort: "invalid", tools: 42, instructions: 42, canSpawn: "invalid", lifecycle: { unknown: true } },
    ]));
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ roles }));
    const loaded = loadConfig(agentDir, root, false);
    assert.equal(loaded.warnings.length, MAX_CONFIG_WARNINGS + 1);
    assert.match(loaded.warnings.at(-1)!, /additional configuration warning\(s\) omitted/i);
    assert.equal(loaded.warnings.every((warning) => Buffer.byteLength(warning, "utf8") <= 512), true);
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
