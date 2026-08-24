import assert from "node:assert/strict";
import { it } from "node:test";
import * as PiAi from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import * as TypeBox from "typebox";
import {
  assertExtensionApiFeatures,
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

it("probes every public startup and restore method before use", () => {
  class IncompleteSessionManager {
    static open() {}
    static create() {}
  }
  class IncompleteSettingsManager {
    static create() {}
    static fromStorage() {}
    getGlobalSettings() {}
  }
  class IncompleteModelRuntime {
    static create() {}
  }
  class IncompleteModelRegistry {}
  class IncompleteAgentSession {}
  const codingAgent = {
    ...PiCodingAgent,
    SessionManager: IncompleteSessionManager,
    SettingsManager: IncompleteSettingsManager,
    ModelRuntime: IncompleteModelRuntime,
    ModelRegistry: IncompleteModelRegistry,
    AgentSession: IncompleteAgentSession,
  } as unknown as Record<string, unknown>;
  assert.throws(
    () => assertPiRuntimeFeatures(
      codingAgent,
      PiAi as unknown as Record<string, unknown>,
      PiTui as unknown as Record<string, unknown>,
      TypeBox as unknown as Record<string, unknown>,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const feature of [
        "SessionManager.prototype.getBranch",
        "SessionManager.prototype.getSessionId",
        "SessionManager.prototype.appendCustomEntry",
        "ModelRuntime.prototype.getModel",
        "ModelRuntime.prototype.getAuth",
        "ModelRuntime.prototype.getProviderAuthStatus",
        "ModelRuntime.prototype.registerNativeProvider",
        "ModelRuntime.prototype.registerProvider",
        "ModelRegistry.prototype.getRegisteredProviderIds",
        "ModelRegistry.prototype.getRegisteredNativeProvider",
        "ModelRegistry.prototype.getRegisteredProviderConfig",
        "ModelRegistry.prototype.getProviderAuthStatus",
        "ModelRegistry.prototype.getAvailable",
        "ModelRegistry.prototype.getAll",
        "SettingsManager.inMemory",
        "SettingsManager.prototype.getProjectSettings",
        "SettingsManager.prototype.drainErrors",
        "SettingsManager.prototype.applyOverrides",
        "AgentSession.prototype.subscribe",
        "AgentSession.prototype.getActiveToolNames",
        "AgentSession.prototype.prompt",
      ]) assert.match(error.message, new RegExp(feature.replaceAll(".", "\\.")));
      return true;
    },
  );
});

it("handles malformed constructors and bounds one combined missing-feature diagnostic", () => {
  const codingAgent = {
    ...PiCodingAgent,
    SessionManager: { open() {}, create() {}, prototype: 42 },
    ModelRuntime: { create() {}, prototype: null },
    ModelRegistry: { prototype: "malformed" },
    SettingsManager: { create() {}, fromStorage() {}, inMemory() {}, prototype: false },
    AgentSession: { prototype: undefined },
  } as unknown as Record<string, unknown>;
  assert.throws(
    () => assertPiRuntimeFeatures(codingAgent, {}, {}, {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /SessionManager\.prototype\.getBranch/);
      assert.match(error.message, /additional required feature\(s\) omitted/);
      assert.ok(Buffer.byteLength(error.message, "utf8") <= 4_096, `diagnostic was ${Buffer.byteLength(error.message, "utf8")} bytes`);
      return true;
    },
  );
});

it("load-safely rejects an incompatible ExtensionAPI instance before registration", () => {
  let touched = false;
  const incomplete = {
    registerTool() { touched = true; },
    registerCommand() { touched = true; },
  };
  assert.throws(
    () => assertExtensionApiFeatures(incomplete),
    /ExtensionAPI\.registerMessageRenderer.*ExtensionAPI\.sendMessage.*ExtensionAPI\.getThinkingLevel.*ExtensionAPI\.on/s,
  );
  assert.equal(touched, false);

  assert.doesNotThrow(() => assertExtensionApiFeatures({
    registerTool() {},
    registerMessageRenderer() {},
    registerCommand() {},
    registerShortcut() {},
    sendMessage() {},
    getThinkingLevel() {},
    on() {},
  }));
});
