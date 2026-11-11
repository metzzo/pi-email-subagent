import assert from "node:assert/strict";
import { it } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  collectWorkerExtensions,
  WORKER_EXTENSION_COLLECT_EVENT,
  WORKER_EXTENSION_PROTOCOL_VERSION,
} from "../../src/worker-extensions.ts";

it("collects synchronous, valid, uniquely named worker extension registrations", () => {
  const events = createEventBus();
  const firstFactory = () => undefined;
  const ignoredFactory = () => undefined;
  events.on(WORKER_EXTENSION_COLLECT_EVENT, (value) => {
    const collector = value as { register(value: unknown): void };
    collector.register({ protocolVersion: 2, name: "compact-warning", factory: firstFactory, tools: ["compact_and_continue"], effects: { compact_and_continue: "write" } });
    collector.register({ protocolVersion: 2, name: "compact-warning", factory: ignoredFactory, tools: ["other_tool"], effects: { other_tool: "read" } });
    collector.register({ protocolVersion: 2, name: "invalid name", factory: ignoredFactory, tools: [], effects: {} });
    collector.register({ protocolVersion: 2, name: "missing-factory", tools: [], effects: {} });
    collector.register({ protocolVersion: 2, name: "bad-tools", factory: ignoredFactory, tools: [""], effects: { "": "read" } });
    const sparseTools: string[] = [];
    sparseTools.length = 1;
    collector.register({ protocolVersion: 2, name: "sparse-tools", factory: ignoredFactory, tools: sparseTools, effects: {} });
    collector.register({ protocolVersion: 2, name: "missing-effects", factory: ignoredFactory, tools: ["effect_tool"] });
    collector.register({ protocolVersion: 2, name: "reserved-tool", factory: ignoredFactory, tools: ["edit"], effects: { edit: "write" } });
    collector.register({ protocolVersion: 2, name: "colliding-tool", factory: ignoredFactory, tools: ["compact_and_continue"], effects: { compact_and_continue: "write" } });
    collector.register({ protocolVersion: 3, name: "future-protocol", factory: ignoredFactory, tools: [], effects: {} });
  });

  const result = collectWorkerExtensions(events);
  assert.equal(result.registrations.length, 1);
  assert.equal(result.registrations[0]?.protocolVersion, WORKER_EXTENSION_PROTOCOL_VERSION);
  assert.equal(result.registrations[0]?.name, "compact-warning");
  assert.equal(result.registrations[0]?.factory, firstFactory);
  assert.deepEqual(result.registrations[0]?.tools, ["compact_and_continue"]);
  assert.deepEqual(result.registrations[0]?.effects, { compact_and_continue: "write" });
  assert.equal(result.issues.length, 9);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.registrations), true);
  assert.equal(Object.isFrozen(result.registrations[0]), true);
  assert.equal(Object.isFrozen(result.registrations[0]?.tools), true);
  assert.equal(Object.isFrozen(result.registrations[0]?.effects), true);
  assert.equal(Object.isFrozen(result.issues), true);
});

for (const tools of [["read"], ["bash"], ["read", "bash"]]) {
  it(`accepts built-in overrides with matching effects: ${tools.join(", ")}`, () => {
    const events = createEventBus();
    const effects = Object.fromEntries(tools.map((tool) => [tool, tool === "read" ? "read" : "write"]));
    events.on(WORKER_EXTENSION_COLLECT_EVENT, (value) => {
      (value as { register(value: unknown): void }).register({
        protocolVersion: 2, name: "lighting-read", factory: () => undefined, tools, effects,
      });
    });
    const result = collectWorkerExtensions(events);
    assert.deepEqual(result.issues, []);
    assert.equal(result.registrations.length, 1);
    assert.deepEqual(result.registrations[0]?.tools, tools);
    assert.deepEqual(result.registrations[0]?.effects, effects);
  });
}

for (const tool of ["read", "bash", "edit", "write", "grep", "find", "ls", "send_email", "fetch_emails", "inspect_agent", "wait_for_replies", "cancel_request", "manage_agent"]) {
  it(`rejects reserved ${tool}${tool === "read" || tool === "bash" ? " with the wrong effect" : " with either effect"}`, () => {
    for (const effect of ["read", "write"]) {
      if ((tool === "read" && effect === "read") || (tool === "bash" && effect === "write")) continue;
      const events = createEventBus();
      events.on(WORKER_EXTENSION_COLLECT_EVENT, (value) => {
        (value as { register(value: unknown): void }).register({
          protocolVersion: 2, name: "reserved", factory: () => undefined, tools: [tool], effects: { [tool]: effect },
        });
      });
      const result = collectWorkerExtensions(events);
      assert.deepEqual(result.registrations, []);
      assert.deepEqual(result.issues, ["Ignored a worker extension registration that claimed a reserved tool name."]);
    }
  });
}

it("returns an empty immutable list when no main extension opts into workers", () => {
  const result = collectWorkerExtensions(createEventBus());
  assert.deepEqual(result, { registrations: [], issues: [] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.registrations), true);
  assert.equal(Object.isFrozen(result.issues), true);
});
