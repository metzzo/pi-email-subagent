import assert from "node:assert/strict";
import { it } from "node:test";
import { summarizeRpcQuiescence } from "../../scripts/live-mechanistic-e2e-support.ts";
const balanced = [
  { type: "agent_start" },
  { type: "agent_end" },
  { type: "agent_start" },
  { type: "agent_end" },
  { type: "agent_settled" },
  { type: "agent_settled" },
];
it("balanced initial and follow-on is quiescent", () =>
  assert.equal(summarizeRpcQuiescence(balanced).quiescent, true));
it("old 2/1/1, unmatched start, retry, initial-only, and settled shortage fail", () => {
  assert.equal(
    summarizeRpcQuiescence([
      { type: "agent_start" },
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_settled" },
    ]).quiescent,
    false,
  );
  assert.equal(
    summarizeRpcQuiescence([
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_settled" },
      { type: "agent_start" },
    ]).quiescent,
    false,
  );
  assert.equal(
    summarizeRpcQuiescence([
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_start" },
      { type: "agent_end", willRetry: true },
      { type: "agent_settled" },
    ]).quiescent,
    false,
  );
  assert.equal(
    summarizeRpcQuiescence([
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_settled" },
    ]).quiescent,
    false,
  );
  assert.equal(
    summarizeRpcQuiescence([
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_start" },
      { type: "agent_end" },
    ]).quiescent,
    false,
  );
});
