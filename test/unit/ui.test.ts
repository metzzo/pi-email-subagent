import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DashboardComponent } from "../../src/ui.ts";
import type { AgentRecord, BrokerSnapshot } from "../../src/types.ts";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function record(): AgentRecord {
  const now = new Date().toISOString();
  return {
    address: "reviewer.a-very-long-security-audit-task@gpt-5.4-mini.com",
    name: "reviewer",
    taskSlug: "a-very-long-security-audit-task",
    provider: "openai-codex",
    modelId: "gpt-5.4-mini",
    effort: "high",
    tools: ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
    state: "running",
    createdAt: now,
    updatedAt: now,
    currentActivity: "Inspecting an intentionally very long path and activity description that must be safely truncated",
    enforcementAttempts: 0,
    usage: { input: 12345, output: 2345, cacheRead: 0, cacheWrite: 0, cost: 0.0123, contextTokens: 20000, turns: 3 },
    activity: [{ at: now, kind: "tool", summary: "read /an/intentionally/long/path/that/should/not/overflow/the/dashboard" }],
  };
}

describe("dashboard rendering", () => {
  it("never emits lines wider than the requested terminal width", () => {
    const snapshot: BrokerSnapshot = {
      mainAddress: "main@gpt-5.4-mini.com",
      agents: [record()],
      unanswered: 1,
      queuedMail: 2,
    };
    const component = new DashboardComponent(
      () => snapshot,
      () => [],
      () => undefined,
      () => undefined,
      fakeTheme,
    );
    for (const width of [20, 40, 60, 80, 120]) {
      const lines = component.render(width);
      assert.ok(lines.length > 0);
      assert.equal(lines.every((line) => visibleWidth(line) <= width), true, `overflow at width ${width}`);
      component.invalidate();
    }
  });
});
