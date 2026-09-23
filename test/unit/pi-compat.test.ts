import assert from "node:assert/strict";
import { it } from "node:test";
import { assertExtensionApiFeatures } from "../../src/pi-compat.ts";

it("checks capabilities independently of the host version", () => {
  for (const VERSION of [undefined, "0.85.1", "0.87.1", "0.100.0", "1.0.0", "99.0.0"]) {
    assert.doesNotThrow(() => assertExtensionApiFeatures({ ...extensionApi(), VERSION }));
  }
  for (const surface of [undefined, null, 1]) {
    assert.throws(() => assertExtensionApiFeatures(surface), /ExtensionAPI\.registerTool/);
  }
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

it("checks only the public ExtensionAPI facade", () => {
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
