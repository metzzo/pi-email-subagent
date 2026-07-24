import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RegistryStore, parseRegistry } from "../../src/registry-store.ts";
import type { AgentRecord, BrokerRegistry } from "../../src/types.ts";

function record(address = "worker.registry@gpt-5.4.com"): AgentRecord {
  const now = new Date().toISOString();
  return {
    address,
    name: "worker",
    taskSlug: "registry",
    provider: "openai-codex",
    modelId: "gpt-5.4",
    effort: "medium",
    tools: ["read", "send_email", "fetch_emails"],
    state: "archived",
    createdAt: now,
    updatedAt: now,
    enforcementAttempts: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    activity: [],
  };
}

function registry(): BrokerRegistry {
  const now = new Date().toISOString();
  return {
    version: 1,
    mainAddress: "main@gpt-5.4.com",
    mainAliases: ["main@gpt-5.4.com"],
    agents: [record()],
    updatedAt: now,
  };
}

describe("registry schema", () => {
  it("round-trips validated archived records", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-registry-"));
    const store = new RegistryStore(join(root, "registry.json"));
    await store.save(registry());
    const restored = await store.load("main@gpt-5.4.com");
    assert.equal(restored.agents[0]?.state, "archived");
  });

  it("rejects malformed records and duplicate identities", async () => {
    assert.throws(() => parseRegistry({ ...registry(), agents: [{ ...record(), state: "mystery" }] }), /state is invalid/);
    assert.throws(() => parseRegistry({ ...registry(), agents: [record(), record()] }), /duplicate agent/);

    const root = await mkdtemp(join(tmpdir(), "pi-email-registry-"));
    const path = join(root, "registry.json");
    await writeFile(path, JSON.stringify({ ...registry(), agents: [{ address: "broken" }] }));
    await assert.rejects(new RegistryStore(path).load("main@gpt-5.4.com"), /corrupt subagent registry/);
  });
});
