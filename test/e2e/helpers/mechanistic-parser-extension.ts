import assert from "node:assert/strict";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mechanisticParserCases } from "../../helpers/mechanistic-parser-cases.ts";
import { collectWorkerExtensions, guardWorkerExtensionFactory, WORKER_EXTENSION_COLLECT_EVENT } from "../../../src/worker-extensions.ts";

export default async function contractExtension(pi: ExtensionAPI): Promise<void> {
  await mechanisticParserCases();
  const factory = (api: ExtensionAPI): void => {
    assert.equal(api.events, pi.events);
    api.registerCommand("contract-loaded", { description: "Parser contract marker", handler: async () => {} });
    api.registerTool({ name: "contract_observe", label: "Observe host platform", description: "Return the real host platform", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: process.platform }], details: {} }) });
  };
  const valid = { protocolVersion: 2 as const, name: "contract", tools: ["contract_observe"], effects: { contract_observe: "read" as const }, factory };
  // Real host event bus and ExtensionAPI: registration records are inputs, not
  // surrogate broker, worker, process or host implementations.
  function collect(values: unknown[]) {
    const remove = pi.events.on(WORKER_EXTENSION_COLLECT_EVENT, (value) => {
      const collector = value as { register(value: unknown): void };
      for (const entry of values) collector.register(entry);
    });
    try { return collectWorkerExtensions(pi.events); } finally { remove(); }
  }
  const invalid = [
    null, "bad", { ...valid, protocolVersion: 3 }, { ...valid, name: "bad name" },
    { ...valid, factory: undefined }, { ...valid, tools: undefined }, { ...valid, tools: Array(129).fill("tool") },
    { ...valid, tools: new Array(1) }, { ...valid, tools: [""] }, { ...valid, tools: [1] }, { ...valid, tools: ["bad.name"] },
    { ...valid, tools: ["x".repeat(256)] }, { ...valid, tools: ["same", "same"] },
    { ...valid, effects: undefined }, { ...valid, effects: [] }, { ...valid, effects: {} },
    { ...valid, effects: { extra: "read" } }, { ...valid, effects: { contract_observe: "unknown" } },
    { ...valid, tools: ["bash"], effects: { bash: "write" } },
  ];
  for (const value of invalid) { const result = collect([value]); assert.equal(result.registrations.length, 0); assert.equal(result.issues.length, 1); }
  assert.equal(collect([valid, valid]).issues.length, 1);
  assert.equal(collect([valid, { ...valid, name: "collision" }]).issues.length, 1);
  const many = Array.from({ length: 17 }, (_, i) => ({ ...valid, name: `program-${i}`, tools: [], effects: {} }));
  assert.equal(collect(many).registrations.length, 16);
  assert.equal(collect(Array(100).fill(null)).issues.length, 64);
  const toolsA = Array.from({ length: 80 }, (_, i) => `a_${i}`); const toolsB = Array.from({ length: 80 }, (_, i) => `b_${i}`);
  assert.equal(collect([{ ...valid, tools: toolsA, effects: Object.fromEntries(toolsA.map((tool) => [tool, "read"])) }, { ...valid, name: "second", tools: toolsB, effects: Object.fromEntries(toolsB.map((tool) => [tool, "write"])) }]).issues.length, 1);
  const collected = collect([valid]); assert.equal(collected.registrations.length, 1);
  await guardWorkerExtensionFactory(collected.registrations[0]!)(pi);
  assert.throws(() => guardWorkerExtensionFactory({ ...valid, tools: [], effects: {} })(pi), /undeclared tool/);
}
