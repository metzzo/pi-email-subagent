import assert from "node:assert/strict";
import { it } from "node:test";
import { assertPiRuntimeFeatures, assertSupportedPiRuntime } from "../../src/pi-compat.ts";

it("accepts the supported Pi public feature surface", () => {
  assert.doesNotThrow(() => assertSupportedPiRuntime());
});

it("reports an actionable supported-Pi error for a missing required public feature", () => {
  assert.throws(
    () => assertPiRuntimeFeatures({ SessionManager: { open() {} } }, {}, {}),
    /requires the Pi 0\.81\.1 public API surface.*@earendil-works\/pi-coding-agent\.getAgentDir.*Install Pi 0\.81\.1/s,
  );
});
