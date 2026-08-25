import assert from "node:assert/strict";
import { it } from "node:test";
import { transitionAbandonedOwnerRecovery } from "../../src/abandoned-owner-recovery.ts";
import { DEFAULT_LIFECYCLE } from "../../src/config.ts";
import type { AgentRecord } from "../../src/types.ts";

function record(): AgentRecord {
  return {
    address: "worker.abandoned@gpt-5.4.com",
    name: "worker",
    taskSlug: "abandoned",
    provider: "openai-codex",
    modelId: "gpt-5.4",
    effort: "medium",
    tools: ["bash", "send_email", "fetch_emails"],
    canSpawn: false,
    state: "paused",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    enforcementAttempts: 0,
    lifecycle: { ...DEFAULT_LIFECYCLE },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    activity: [],
  };
}

it("synthesizes exact abandoned-owner quarantine for every active mutation-capable epoch", () => {
  const source = record();
  source.workerEpoch = {
    generation: 7, phase: "activated", tools: ["bash"], mutationCapable: true, runSlotHeld: false,
  };
  const transitioned = transitionAbandonedOwnerRecovery(source, "2026-08-25T01:00:00.000Z");
  assert.equal(transitioned.changed, true);
  assert.equal(transitioned.record.state, "failed");
  assert.equal(transitioned.record.cleanup?.reasonCode, "ABANDONED_OWNER_RECOVERY");
  assert.equal(transitioned.record.cleanup?.workerGeneration, 7);
  assert.equal(transitioned.record.cleanup?.heldRunSlot, false);
  assert.equal(source.cleanup, undefined, "transition is pure");
});

it("conservatively quarantines writable legacy records and retains existing cleanup diagnostics", () => {
  const legacy = record();
  const normalizedLegacy = transitionAbandonedOwnerRecovery(legacy, "2026-08-25T01:00:00.000Z");
  assert.equal(normalizedLegacy.record.cleanup?.reasonCode, "ABANDONED_OWNER_RECOVERY");
  assert.equal(normalizedLegacy.record.cleanup?.workerGeneration, 1);
  assert.equal(normalizedLegacy.record.cleanup?.heldRunSlot, true);

  const existing = record();
  existing.workerEpoch = {
    generation: 8, phase: "activated", tools: ["bash"], mutationCapable: true, runSlotHeld: true,
  };
  existing.cleanup = {
    state: "pending",
    reasonCode: "WORKER_CLEANUP_REPORT_UNKNOWN",
    workerGeneration: 8,
    startedAt: "2026-08-25T00:30:00.000Z",
    updatedAt: "2026-08-25T00:30:00.000Z",
    abort: "pending",
    dispose: "pending",
    quiescence: "unknown",
    mutationCapableAtStart: true,
    heldRunSlot: true,
    activeTools: [],
    detail: "preserve this exact prior diagnostic",
  };
  const normalizedExisting = transitionAbandonedOwnerRecovery(existing, "2026-08-25T01:00:00.000Z").record;
  assert.equal(normalizedExisting.cleanup?.reasonCode, "WORKER_CLEANUP_REPORT_UNKNOWN");
  assert.equal(normalizedExisting.cleanup?.detail?.includes("preserve this exact prior diagnostic"), true);
  assert.equal(normalizedExisting.cleanup?.state, "unknown");
  assert.equal(normalizedExisting.cleanup?.abort, "timed-out");
  assert.equal(normalizedExisting.cleanup?.dispose, "timed-out");
});

it("does not synthesize quarantine for exact verified-clean or exact operator-released current epochs", () => {
  const verified = record();
  verified.state = "stopped";
  verified.workerEpoch = {
    generation: 9, phase: "verified-clean", tools: ["bash"], mutationCapable: true, runSlotHeld: false,
  };
  assert.deepEqual(transitionAbandonedOwnerRecovery(verified).record, verified);

  const released = record();
  released.state = "failed";
  released.workerEpoch = {
    generation: 9, phase: "operator-released", tools: ["bash"], mutationCapable: true, runSlotHeld: false,
  };
  released.lastCleanupRecovery = {
    workerGeneration: 9,
    releasedAt: "2026-08-25T01:00:00.000Z",
    evidence: "Operator checked external quiescence.",
    source: "operator-attested",
  };
  assert.deepEqual(transitionAbandonedOwnerRecovery(released).record, released);
});
