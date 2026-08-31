import assert from "node:assert/strict";
import { it } from "node:test";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  assertExtensionApiFeatures,
  assertPiVersion,
  assertSupportedPiRuntime,
  SUPPORTED_PI_VERSION,
} from "../../src/pi-compat.ts";

it("accepts the exact installed Pi version", () => {
  assert.equal(PiCodingAgent.VERSION, SUPPORTED_PI_VERSION);
  assert.doesNotThrow(() => assertSupportedPiRuntime());
  assert.doesNotThrow(() => assertPiVersion({ VERSION: SUPPORTED_PI_VERSION }));
});

it("rejects wrong, missing, and hostile Pi version values without echoing unsafe text", () => {
  assert.throws(
    () => assertPiVersion({ VERSION: "0.84.3" }),
    /requires exact Pi 0\.84\.2; actual 0\.84\.3/i,
  );
  assert.throws(
    () => assertPiVersion({ VERSION: "bad\n<unsafe>" }),
    (error: unknown) => {
      assert.match(String(error), /actual missing or invalid/i);
      assert.doesNotMatch(String(error), /<unsafe>/);
      return true;
    },
  );
  assert.throws(() => assertPiVersion({}), /actual missing or invalid/i);
});

function extensionApi(): Record<string, unknown> {
  return {
    registerTool() {},
    registerMessageRenderer() {},
    registerCommand() {},
    registerShortcut() {},
    sendMessage() {},
    getThinkingLevel() {},
    on() {},
    events: { emit() {} },
  };
}

it("checks only the public ExtensionAPI facade after the exact version gate", () => {
  assert.doesNotThrow(() => assertExtensionApiFeatures(extensionApi()));
  const incomplete = extensionApi();
  delete incomplete.sendMessage;
  delete incomplete.registerTool;
  assert.throws(
    () => assertExtensionApiFeatures(incomplete),
    /ExtensionAPI\.registerTool.*ExtensionAPI\.sendMessage/is,
  );
  const missingEmit = extensionApi();
  missingEmit.events = {};
  assert.throws(() => assertExtensionApiFeatures(missingEmit), /ExtensionAPI\.events\.emit/);
});

it("handles throwing ExtensionAPI accessors as missing features", () => {
  const surface = extensionApi();
  Object.defineProperty(surface, "on", { get() { throw new Error("hostile getter"); } });
  assert.throws(() => assertExtensionApiFeatures(surface), /ExtensionAPI\.on/);
});
