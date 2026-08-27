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

it("marks an exact dead owner's active Pi session inactive without synthesizing cleanup quarantine", () => {
  const source = record();
  source.state = "running";
  source.workerEpoch = {
    generation: 7, phase: "activated", tools: ["bash"], mutationCapable: true, runSlotHeld: true,
  };
  const transitioned = transitionAbandonedOwnerRecovery(source, "2026-08-25T01:00:00.000Z");
  assert.equal(transitioned.changed, true);
  assert.equal(transitioned.record.state, "failed");
  assert.equal(transitioned.record.cleanup, undefined);
  assert.equal(transitioned.record.workerEpoch?.phase, "session-settled");
  assert.equal(transitioned.record.workerEpoch?.runSlotHeld, false);
  assert.match(transitioned.record.failure ?? "", /exact prior broker owner died.*explicit same-identity restart/i);
  assert.match(transitioned.record.failure ?? "", /no OS-process proof/i);
  assert.equal(source.state, "running", "transition is pure");
});

it("migrates the exact old completed-Bash generation 9 shape to failed without cleanup", () => {
  const prior = record();
  prior.state = "failed";
  prior.workerEpoch = {
    generation: 9, phase: "activated", tools: ["bash"], mutationCapable: true, runSlotHeld: false,
  };
  prior.cleanup = {
    state: "unknown",
    reasonCode: "WORKER_CLEANUP_REPORT_UNKNOWN",
    workerGeneration: 9,
    startedAt: "2026-08-25T00:30:00.000Z",
    updatedAt: "2026-08-25T00:30:00.000Z",
    abort: "succeeded",
    dispose: "succeeded",
    quiescence: "unknown",
    mutationCapableAtStart: true,
    heldRunSlot: false,
    activeTools: [],
    detail: "Pi 0.84.2 process receipt unavailable",
  };
  const migrated = transitionAbandonedOwnerRecovery(prior, "2026-08-25T02:00:00.000Z");
  assert.equal(migrated.record.state, "failed");
  assert.equal(migrated.record.cleanup, undefined);
  assert.equal(migrated.record.workerEpoch?.phase, "session-settled");
  assert.match(migrated.record.failure ?? "", /historical cleanup generation 9.*Pi session\/tool settled/i);
  assert.match(migrated.record.failure ?? "", /no OS-process proof.*explicit same-identity restart/i);
});

it("keeps a structurally ambiguous cleanup blocked only at its exact address", () => {
  const ambiguous = record();
  ambiguous.state = "failed";
  ambiguous.workerEpoch = {
    generation: 10, phase: "activated", tools: ["bash"], mutationCapable: true, runSlotHeld: true,
  };
  ambiguous.cleanup = {
    state: "pending",
    reasonCode: "LIFECYCLE_RUN_TIMEOUT",
    workerGeneration: 9,
    startedAt: "2026-08-25T00:30:00.000Z",
    updatedAt: "2026-08-25T00:30:00.000Z",
    abort: "pending",
    dispose: "pending",
    quiescence: "unknown",
    mutationCapableAtStart: true,
    heldRunSlot: true,
    activeTools: [{ toolCallId: "call-9", toolName: "bash" }],
  };
  const normalized = transitionAbandonedOwnerRecovery(ambiguous, "2026-08-25T02:00:00.000Z").record;
  assert.equal(normalized.state, "failed");
  assert.equal(normalized.cleanup?.workerGeneration, 9);
  assert.equal(normalized.cleanup?.heldRunSlot, false, "a dead process cannot retain an in-process run slot");
  assert.match(normalized.cleanup?.detail ?? "", /does not match.*worker epoch 10/i);
  assert.match(normalized.failure ?? "", /only this address remains blocked/i);
});

it("leaves already session-settled stopped or archived records unchanged", () => {
  for (const state of ["stopped", "archived"] as const) {
    const settled = record();
    settled.state = state;
    settled.workerEpoch = {
      generation: 9, phase: "session-settled", tools: ["bash"], mutationCapable: true, runSlotHeld: false,
    };
    const result = transitionAbandonedOwnerRecovery(settled);
    assert.equal(result.changed, false, state);
    assert.deepEqual(result.record, settled, state);
  }
});
