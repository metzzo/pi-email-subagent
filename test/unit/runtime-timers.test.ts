import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_TIMER_DELAY_MS } from "../../src/config.ts";
import { deadlineSignal, lifecycleDuration, runtimeSafeDelay } from "../../src/runtime-timers.ts";

describe("runtime-safe timers", () => {
  it("bounds every Node delay without overflowing lifecycle sums", () => {
    assert.equal(runtimeSafeDelay(0), 0);
    assert.equal(runtimeSafeDelay(MAX_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS);
    assert.equal(runtimeSafeDelay(MAX_TIMER_DELAY_MS + 1), MAX_TIMER_DELAY_MS);
    assert.equal(lifecycleDuration(MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS * 2);
  });

  it("supports cancellable absolute deadline chunks", async () => {
    const deadline = deadlineSignal(5);
    await deadline.promise;
    deadline.cancel();
    assert.ok(true);
  });
});
