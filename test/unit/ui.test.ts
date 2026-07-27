import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ConversationComponent, conversationBlocks, DashboardComponent, formatConversationTranscript } from "../../src/ui.ts";
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
    canSpawn: true,
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

  it("opens running, stopped, and archived agent conversations with ctrl+o", () => {
    for (const state of ["running", "stopped", "archived"] as const) {
      const agent = record();
      agent.state = state;
      agent.sessionFile = `/tmp/${state}.jsonl`;
      const snapshot: BrokerSnapshot = {
        mainAddress: "main@gpt-5.4-mini.com",
        agents: [agent],
        unanswered: 0,
        queuedMail: 0,
      };
      let action: { kind: string; address?: string } | undefined;
      const component = new DashboardComponent(
        () => snapshot,
        () => [],
        (next) => { action = next; },
        () => undefined,
        fakeTheme,
      );
      component.handleInput("\x0f");
      assert.deepEqual(action, { kind: "conversation", address: agent.address });
    }
  });

  it("renders the full visible conversation without exposing thinking", () => {
    const timestamp = new Date().toISOString();
    const entries = [
      {
        type: "message", id: "user", parentId: null, timestamp,
        message: { role: "user", content: "Complete request body", timestamp: Date.now() },
      },
      {
        type: "message", id: "assistant", parentId: "user", timestamp,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden chain of thought" },
            { type: "text", text: "Visible answer with enough words to wrap across narrow terminals." },
            { type: "toolCall", id: "call", name: "read", arguments: { path: "/tmp/example.ts" } },
          ],
          timestamp: Date.now(), provider: "test", model: "test", api: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
        },
      },
      {
        type: "message", id: "tool", parentId: "assistant", timestamp,
        message: {
          role: "toolResult", toolCallId: "call", toolName: "read",
          content: [{ type: "text", text: "Full tool result" }], isError: false, timestamp: Date.now(),
        },
      },
    ] as unknown as SessionEntry[];
    const blocks = conversationBlocks(entries);
    const serialized = JSON.stringify(blocks);
    assert.match(serialized, /Complete request body/);
    assert.match(serialized, /Visible answer/);
    assert.match(serialized, /example\.ts/);
    assert.match(serialized, /Full tool result/);
    assert.doesNotMatch(serialized, /hidden chain of thought/);
    const transcript = formatConversationTranscript(blocks);
    assert.match(transcript, /Complete request body/);
    assert.match(transcript, /Full tool result/);
    assert.doesNotMatch(transcript, /hidden chain of thought/);

    let closed = false;
    const component = new ConversationComponent(
      record().address,
      { blocks },
      () => { closed = true; },
      () => undefined,
      fakeTheme,
      6,
    );
    for (const width of [20, 40, 80]) {
      assert.equal(component.render(width).every((line) => visibleWidth(line) <= width), true);
    }
    component.handleInput("\x0f");
    assert.equal(closed, true);
  });
});
