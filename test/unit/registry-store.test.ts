import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_LIFECYCLE } from "../../src/config.ts";
import { RegistryStore, parseRegistry } from "../../src/registry-store.ts";
import type { AgentRecord, BrokerRegistry } from "../../src/types.ts";
import { emptyWorkState, MAX_ACTIVE_WORK, MAX_PATCH_BYTES, MAX_RECENT_WORK } from "../../src/work-ledger.ts";

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
    canSpawn: true,
    state: "archived",
    createdAt: now,
    updatedAt: now,
    enforcementAttempts: 0,
    lifecycle: { ...DEFAULT_LIFECYCLE },
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

  it("fails closed when legacy registries omit delegation permission", () => {
    const legacy = registry() as unknown as { agents: Record<string, unknown>[] };
    delete legacy.agents[0]!.canSpawn;
    const parsed = parseRegistry(JSON.parse(JSON.stringify(legacy)));
    assert.equal(parsed.agents[0]?.canSpawn, false);
    assert.deepEqual(parsed.agents[0]?.work, emptyWorkState());
    legacy.agents[0]!.currentActivity = 'write {"content":"SENTINEL_SECRET"}';
    legacy.agents[0]!.activity = [{ at: new Date().toISOString(), kind: "tool", summary: 'edit {"newText":"SENTINEL_SECRET"}' }];
    const scrubbed = parseRegistry(JSON.parse(JSON.stringify(legacy)));
    assert.doesNotMatch(JSON.stringify(scrubbed), /SENTINEL_SECRET/);
    delete legacy.agents[0]!.lifecycle;
    const lifecycleLegacy = parseRegistry(JSON.parse(JSON.stringify(legacy)));
    assert.deepEqual(lifecycleLegacy.agents[0]?.lifecycle, DEFAULT_LIFECYCLE);

    legacy.agents[0]!.canSpawn = "yes";
    assert.throws(() => parseRegistry(JSON.parse(JSON.stringify(legacy))), /canSpawn must be a boolean/);
  });

  it("round-trips bounded cleanup quarantine and rejects malformed diagnostics", () => {
    const base = record();
    const now = new Date().toISOString();
    (base as any).cleanup = {
      state: "unknown",
      reasonCode: "LIFECYCLE_RUN_TIMEOUT",
      workerGeneration: 7,
      startedAt: now,
      updatedAt: now,
      abort: "succeeded",
      dispose: "succeeded",
      quiescence: "unknown",
      mutationCapableAtStart: true,
      heldRunSlot: false,
      activeTools: [{ toolCallId: "call-1", toolName: "bash" }],
      detail: "Pi 0.81.1 exposes no process-quiescence receipt.",
    };
    const parsed = parseRegistry({ ...registry(), agents: [base] });
    assert.deepEqual((parsed.agents[0] as any).cleanup, (base as any).cleanup);

    for (const cleanup of [
      { ...(base as any).cleanup, state: "verified" },
      { ...(base as any).cleanup, workerGeneration: -1 },
      { ...(base as any).cleanup, startedAt: "not-a-time" },
      { ...(base as any).cleanup, abort: "maybe" },
      { ...(base as any).cleanup, mutationCapableAtStart: "yes" },
      { ...(base as any).cleanup, heldRunSlot: "yes" },
      { ...(base as any).cleanup, activeTools: [{ toolCallId: "x".repeat(201), toolName: "bash" }] },
      { ...(base as any).cleanup, detail: "x".repeat(2_001) },
    ]) {
      assert.throws(() => parseRegistry({ ...registry(), agents: [{ ...base, cleanup }] }), /cleanup/i);
    }
  });

  it("bounds registry work caches and rejects malformed or duplicate work IDs", () => {
    const base = record();
    const item = {
      toolCallId: "id", batchId: 1, toolName: "edit", kind: "edit", attribution: "explicit", status: "succeeded",
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), path: "/tmp/a", displayPath: "(absolute) /tmp/a", patchPreview: "+🙂".repeat(MAX_PATCH_BYTES),
    };
    base.work = { ...emptyWorkState(), recent: Array.from({ length: MAX_RECENT_WORK + 20 }, (_, index) => ({ ...item, toolCallId: `id${index}` })) } as never;
    const parsed = parseRegistry({ ...registry(), agents: [base] });
    assert.equal(parsed.agents[0]!.work!.recent.length, MAX_RECENT_WORK);
    assert.ok(Buffer.byteLength(parsed.agents[0]!.work!.recent[0]!.patchPreview!, "utf8") <= MAX_PATCH_BYTES);
    base.work = { ...emptyWorkState(), active: Array.from({ length: MAX_ACTIVE_WORK + 1 }, (_, index) => ({ ...item, toolCallId: `active${index}`, status: "running", endedAt: undefined })), recent: [] } as never;
    assert.throws(() => parseRegistry({ ...registry(), agents: [base] }), /active exceeds the 64-item safety bound/);
    base.work = { ...emptyWorkState(), active: [{ ...item, status: "running", endedAt: undefined }], recent: [item] } as never;
    assert.throws(() => parseRegistry({ ...registry(), agents: [base] }), /duplicate toolCallId/);
    base.work = { ...emptyWorkState(), active: [{ ...item, toolCallId: "unsafe", status: "running", endedAt: undefined, path: "/tmp/bad\u001b]0;pwn\u0007", displayPath: "bad\nname" }], recent: [] } as never;
    assert.throws(() => parseRegistry({ ...registry(), agents: [base] }), /explicit work requires a path/);
    base.work = { nope: true } as never;
    assert.throws(() => parseRegistry({ ...registry(), agents: [base] }), /work.*malformed/);
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
