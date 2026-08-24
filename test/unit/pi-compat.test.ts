import assert from "node:assert/strict";
import { it } from "node:test";
import * as PiAi from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import * as TypeBox from "typebox";
import {
  assertPiRuntimeFeatures,
  assertSupportedPiRuntime,
  collectedReplyPresentationCapability,
  directMutationAliasSerializationCapability,
  processQuiescenceReceiptCapability,
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

it("keeps process cleanup and mutation-alias integrations disabled without released authoritative contracts", () => {
  const processReceipt = processQuiescenceReceiptCapability();
  assert.equal(processReceipt.supported, false);
  assert.equal(processReceipt.detailCode, "PI_0_81_1_PROCESS_QUIESCENCE_RECEIPT_UNAVAILABLE");
  assert.match(processReceipt.reason, /Pi 0\.81\.1.*session.*generation.*process.*receipt/i);
  for (const requirement of [/provider/i, /callbacks/i, /active tool/i, /completed process group/i, /idempotent/i]) {
    assert.match(processReceipt.requiredCoreContract, requirement);
  }

  const mutationAliases = directMutationAliasSerializationCapability();
  assert.equal(mutationAliases.supported, false);
  assert.equal(mutationAliases.detailCode, "PI_0_81_1_MUTATION_ALIAS_IDENTITY_UNAVAILABLE");
  for (const fact of [/Pi 0\.81\.1/i, /missing target/i, /hard-link/i, /queue key/i]) {
    assert.match(mutationAliases.reason, fact);
  }
  assert.match(mutationAliases.requiredCoreContract, /missing-target symlink.*hard-link.*replacement.*concurrent create/i);
});

it("reports an actionable supported-Pi error for a missing required public feature", () => {
  assert.throws(
    () => assertPiRuntimeFeatures({ SessionManager: { open() {} } }, {}, {}, {}),
    /requires the Pi 0\.81\.1 public API surface.*@earendil-works\/pi-coding-agent\.getAgentDir.*Install Pi 0\.81\.1/s,
  );
});

it("probes the public no-write settings snapshot and auth-status surface before use", () => {
  class IncompleteSettingsManager {
    static create() {}
    getGlobalSettings() {}
  }
  class IncompleteModelRuntime {
    static create() {}
  }
  const codingAgent = {
    ...PiCodingAgent,
    SettingsManager: IncompleteSettingsManager,
    ModelRuntime: IncompleteModelRuntime,
  } as unknown as Record<string, unknown>;
  assert.throws(
    () => assertPiRuntimeFeatures(
      codingAgent,
      PiAi as unknown as Record<string, unknown>,
      PiTui as unknown as Record<string, unknown>,
      TypeBox as unknown as Record<string, unknown>,
    ),
    /ModelRuntime\.prototype\.getProviderAuthStatus.*SettingsManager\.fromStorage.*SettingsManager\.prototype\.getProjectSettings/s,
  );
});
