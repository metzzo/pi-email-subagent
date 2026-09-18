import assert from "node:assert/strict";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentBroker } from "../../src/broker.ts";
import type { AgentRecord, BrokerRegistry, LlmAgentRecord } from "../../src/types.ts";

/** Existing LLM-only regression fixtures must not silently receive a script variant. */
export function llmRecords(records: AgentRecord[]): LlmAgentRecord[] {
  for (const record of records) assert.equal(record.kind, "llm", "expected an ordinary LLM identity");
  return records as LlmAgentRecord[];
}
export function llmSnapshot(broker: AgentBroker) {
  const snapshot = broker.getSnapshot();
  return { ...snapshot, agents: llmRecords(snapshot.agents) };
}
export function inspectLlm(broker: AgentBroker, address: string, effort?: ThinkingLevel) {
  const inspection = broker.inspectAgent(address, effort);
  assert.equal(inspection.kind, "llm", "expected an ordinary LLM inspection");
  if (inspection.kind !== "llm") throw new Error("Expected LLM inspection");
  return inspection;
}
export function llmRegistry(registry: BrokerRegistry) {
  return { ...registry, agents: llmRecords(registry.agents) };
}
