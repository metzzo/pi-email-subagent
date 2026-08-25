import assert from "node:assert/strict";
import { it } from "node:test";
import { parseCleanupRecoveryCommand, sanitizeCleanupRecoveryEvidence } from "../../src/cleanup-recovery.ts";

it("parses only the explicit exact-generation manual cleanup recovery form", () => {
  assert.deepEqual(
    parseCleanupRecoveryCommand("recover-cleanup worker.p3-proposer@gpt-5.6-sol.com 9 --confirm Operator verified external quiescence."),
    {
      address: "worker.p3-proposer@gpt-5.6-sol.com",
      workerGeneration: 9,
      confirmed: true,
      evidence: "Operator verified external quiescence.",
    },
  );
  for (const value of [
    "recover-cleanup worker.p3-proposer@gpt-5.6-sol.com 9 Operator verified quiescence",
    "recover-cleanup worker.p3-proposer@gpt-5.6-sol.com nine --confirm Operator verified quiescence",
    "recover-cleanup worker.p3-proposer@gpt-5.6-sol.com 9 --confirm",
  ]) assert.throws(() => parseCleanupRecoveryCommand(value), /usage|positive integer/i);
});

it("bounds and redacts operator evidence before it reaches the durable audit", () => {
  assert.equal(
    sanitizeCleanupRecoveryEvidence("  external check; Authorization: Bearer top-secret-value  "),
    "external check; Authorization: [redacted]",
  );
  assert.throws(() => sanitizeCleanupRecoveryEvidence("short"), /at least 8/);
  assert.throws(() => sanitizeCleanupRecoveryEvidence("x".repeat(1_025)), /1024 UTF-8 bytes/);
});
