import assert from "node:assert/strict";
import { it } from "node:test";
import {
  assertPiRuntimeFeatures,
  assertSupportedPiRuntime,
  collectedReplyPresentationCapability,
} from "../../src/pi-compat.ts";

it("accepts the supported Pi public feature surface", () => {
  assert.doesNotThrow(() => assertSupportedPiRuntime());
});

it("fails closed on collected-reply presentation without a staged Pi receipt", () => {
  const capability = collectedReplyPresentationCapability();
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /Pi 0\.81\.1.*no post-append acknowledgement/i);
  assert.match(capability.requiredCoreContract, /stable request\/reply\/toolCall\/result-entry.*callback.*before Pi continues/i);
});

it("reports an actionable supported-Pi error for a missing required public feature", () => {
  assert.throws(
    () => assertPiRuntimeFeatures({ SessionManager: { open() {} } }, {}, {}, {}),
    /requires the Pi 0\.81\.1 public API surface.*@earendil-works\/pi-coding-agent\.getAgentDir.*Install Pi 0\.81\.1/s,
  );
});
