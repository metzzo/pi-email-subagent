import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LIFECYCLE } from "../../src/config.ts";
import { ConversationComponent, conversationBlocks, DashboardComponent, formatConversationTranscript, UIController, WorkDiffComponent } from "../../src/ui.ts";
import { emptyWorkState, finishWorkItem, startWorkItem } from "../../src/work-ledger.ts";
import type { AgentRecord, BrokerSnapshot } from "../../src/types.ts";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

const TEST_CAPACITY = { identitiesUsed: 1, identitiesLimit: 8, runSlotsUsed: 1, runSlotsLimit: 4 };

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
    lifecycle: { ...DEFAULT_LIFECYCLE },
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
      capacity: TEST_CAPACITY,
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

  it("discloses the enforced lifecycle in agent detail", () => {
    const agent = record();
    const component = new DashboardComponent(
      () => ({ mainAddress: "main@gpt-5.4-mini.com", agents: [agent], unanswered: 0, queuedMail: 0, capacity: TEST_CAPACITY }),
      () => [],
      () => undefined,
      () => undefined,
      fakeTheme,
    );
    component.handleInput("\r");
    const detail = component.render(240).join("\n");
    assert.match(detail, new RegExp(`lifecycle: spawn ${agent.lifecycle.spawnTimeoutMs}ms`));
    assert.match(detail, new RegExp(`run ${agent.lifecycle.runTimeoutMs}ms`));
  });

  it("renders the canonical agents bar without the redundant footer counter", () => {
    const statuses: Array<string | undefined> = [];
    const widgets: Array<{ lines: string[] | undefined; placement?: string }> = [];
    const ctx = {
      ui: {
        setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
        setWidget: (_key: string, lines: string[] | undefined, options?: { placement?: string }) => {
          widgets.push({ lines, placement: options?.placement });
        },
      },
    } as unknown as ExtensionContext;
    const controller = new UIController();
    controller.bind(ctx);
    controller.update({
      mainAddress: "main@gpt-5.4-mini.com",
      agents: [record()],
      unanswered: 0,
      queuedMail: 0,
      capacity: { identitiesUsed: 1, identitiesLimit: 8, runSlotsUsed: 1, runSlotsLimit: 4 },
    } as any);

    assert.deepEqual(statuses, [undefined]);
    assert.deepEqual(widgets, [{
      lines: ["Agents: 1 running · 0 queued · 0 idle · 0 unanswered · identity capacity 1/8 · run slots 1/4"],
      placement: "belowEditor",
    }]);
  });

  it("shows bounded global capacity and exact selected recovery facts without private mail leakage", () => {
    const agent = record();
    agent.state = "stopped";
    const snapshot = {
      mainAddress: "main@test",
      agents: [agent],
      unanswered: 2,
      queuedMail: 0,
      capacity: { identitiesUsed: 1, identitiesLimit: 1, runSlotsUsed: 0, runSlotsLimit: 1 },
    } as BrokerSnapshot;
    const inspection = {
      state: "stopped",
      holdsActivationLease: true,
      capacity: snapshot.capacity,
      queued: 0,
      unanswered: 1,
      outgoingUnanswered: 1,
      pendingReplies: 0,
      archiveEligible: false,
      archiveBlockers: {
        active: false,
        cleanupQuarantine: false,
        queued: { count: 0, requestIds: [], omitted: 0 },
        incomingUnanswered: { count: 1, requestIds: ["mail_incoming"], omitted: 0 },
        outgoingUnanswered: { count: 1, requestIds: ["mail_outgoing"], omitted: 0 },
        pendingReplies: { count: 0, requestIds: [], omitted: 0 },
      },
    };
    const component = new DashboardComponent(
      () => snapshot,
      () => [{
        id: "mail_private", from: "worker.unrelated@gpt-5.4.com", to: agent.address,
        subject: "PRIVATE SUBJECT", message: "PRIVATE BODY", priority: "low", kind: "request",
        requiresResponse: true, createdAt: new Date().toISOString(), deliveryState: "delivered",
      }],
      () => undefined,
      () => undefined,
      fakeTheme,
      undefined,
      undefined,
      24,
      () => inspection as never,
    );
    for (const width of [20, 40, 80, 120]) {
      const header = component.render(width).join("\n");
      assert.match(header, /identity.*1\/1/i);
      assert.match(header, /run.*0\/1/i);
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    }
    assert.match(component.render(120).join("\n"), /FULL.*reuse|reuse.*FULL/i);
    component.handleInput("\r");
    component.handleInput("\t");
    component.handleInput("\t");
    component.handleInput("\t");
    const profile = component.render(120).join("\n");
    assert.match(profile, /internal state: stopped/i);
    assert.match(profile, /binding: persisted openai-codex\/gpt-5\.4.*preserved across main-provider changes/i);
    assert.match(profile, /activation lease: held/i);
    assert.match(profile, /identity capacity: 1\/1.*run slots: 0\/1/i);
    assert.match(profile, /1 incoming unanswered.*1 outgoing unanswered/i);
    assert.match(profile, /archive eligible: no/i);
    assert.match(profile, /restart.*real obligations|cancel only.*explicitly abandoned/i);
    assert.doesNotMatch(profile, /PRIVATE SUBJECT|PRIVATE BODY|worker\.unrelated/i);
    (inspection as { providerReady?: string }).providerReady = "unavailable";
    const unavailableProfile = component.render(120).join("\n");
    assert.match(unavailableProfile, /binding: persisted openai-codex\/gpt-5\.4.*unavailable.*no provider substitution/i);
    assert.doesNotMatch(unavailableProfile, /PRIVATE SUBJECT|PRIVATE BODY|worker\.unrelated/i);
    component.handleInput("i");
    const inbox = component.render(120).join("\n");
    assert.match(inbox, /PRIVATE SUBJECT/);
    assert.match(inbox, /PRIVATE BODY/);
    assert.match(inbox, /worker\.unrelated/);
    component.dispose();
  });

  it("warns on terminal failure that current-batch effects may exist without leaking mailbox content", () => {
    const agent = record();
    agent.state = "failed";
    agent.failure = "fetch failed terminally";
    agent.activity.push({ at: new Date().toISOString(), kind: "status", summary: "Agent run failed" });
    agent.work = emptyWorkState();
    agent.work.currentBatchId = 3;
    agent.work.recent.push(finishWorkItem(
      startWorkItem("effect", "bash", { command: "PRIVATE EFFECT COMMAND" }, 3, "/work")!,
      {},
      false,
    ));
    const snapshot = {
      mainAddress: "main@test",
      agents: [agent],
      unanswered: 1,
      queuedMail: 0,
      capacity: { identitiesUsed: 1, identitiesLimit: 8, runSlotsUsed: 0, runSlotsLimit: 4 },
    } as BrokerSnapshot;
    const inspection = {
      state: "failed",
      holdsActivationLease: true,
      capacity: snapshot.capacity,
      queued: 0,
      unanswered: 1,
      outgoingUnanswered: 0,
      pendingReplies: 0,
      archiveEligible: false,
      archiveBlockers: {
        active: false,
        cleanupQuarantine: false,
        queued: { count: 0, requestIds: [], omitted: 0 },
        incomingUnanswered: { count: 1, requestIds: ["mail_open"], omitted: 0 },
        outgoingUnanswered: { count: 0, requestIds: [], omitted: 0 },
        pendingReplies: { count: 0, requestIds: [], omitted: 0 },
      },
    };
    const component = new DashboardComponent(
      () => snapshot,
      () => [{
        id: "mail_open", from: "main@test", to: agent.address, subject: "PRIVATE SUBJECT", message: "PRIVATE BODY",
        priority: "low", kind: "request", requiresResponse: true, createdAt: new Date().toISOString(), deliveryState: "delivered",
      }],
      () => undefined,
      () => undefined,
      fakeTheme,
      undefined,
      undefined,
      40,
      () => inspection as never,
    );
    for (const width of [20, 40, 80, 120]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    component.handleInput("\r");
    component.handleInput("\t");
    component.handleInput("\t");
    component.handleInput("\t");
    const profile = component.render(120).join("\n");
    assert.match(profile, /terminal worker run failure.*openai-codex\/gpt-5\.4-mini/i);
    assert.match(profile, /1 delivered request remains unanswered/i);
    assert.match(profile, /current batch includes mutation\/shell\/custom work.*effects may exist/i);
    assert.match(profile, /inspect Work and Conversation.*explicit same-identity restart/i);
    assert.match(profile, /do not redelegate.*possible-effect scope.*original obligation remains open/i);
    assert.doesNotMatch(profile, /PRIVATE SUBJECT|PRIVATE BODY|PRIVATE EFFECT COMMAND/);
    component.dispose();
  });

  it("says an empty current work ledger is not proof of pre-tool safety after failure", () => {
    const agent = record(); agent.state = "failed"; agent.failure = "WebSocket error terminally";
    agent.activity.push({ at: new Date().toISOString(), kind: "status", summary: "Agent run failed" }); agent.work = emptyWorkState();
    const snapshot = { mainAddress: "main@test", agents: [agent], unanswered: 0, queuedMail: 0, capacity: TEST_CAPACITY };
    const inspection = {
      state: "failed", holdsActivationLease: true, capacity: TEST_CAPACITY, queued: 0, unanswered: 0,
      outgoingUnanswered: 0, pendingReplies: 0, archiveEligible: false,
      archiveBlockers: {
        active: false, cleanupQuarantine: false,
        queued: { count: 0, requestIds: [], omitted: 0 }, incomingUnanswered: { count: 0, requestIds: [], omitted: 0 },
        outgoingUnanswered: { count: 0, requestIds: [], omitted: 0 }, pendingReplies: { count: 0, requestIds: [], omitted: 0 },
      },
    };
    const component = new DashboardComponent(() => snapshot, () => [], () => undefined, () => undefined, fakeTheme, undefined, undefined, 40, () => inspection as never);
    component.handleInput("\r"); component.handleInput("\t"); component.handleInput("\t"); component.handleInput("\t");
    const profile = component.render(120).join("\n");
    assert.match(profile, /No mutation\/shell\/custom effect is recorded.*not proof of pre-tool failure/i);
    assert.match(profile, /inspect Conversation.*explicit same-identity restart/i);
    component.dispose();
  });

  it("renders paused, stopped, and archived as closed without changing their internal states", () => {
    const closedStates = ["paused", "stopped", "archived"] as const;
    for (const state of closedStates) {
      const agent = record();
      agent.state = state;
      const component = new DashboardComponent(
        () => ({ mainAddress: "main@test", agents: [agent], unanswered: 0, queuedMail: 0, capacity: TEST_CAPACITY }),
        () => [],
        () => undefined,
        () => undefined,
        fakeTheme,
      );
      const list = component.render(120).join("\n");
      assert.match(list, /■/);
      assert.match(list, /\bclosed\b/);
      assert.doesNotMatch(list, new RegExp(`\\b${state}\\b`));
      component.handleInput("\r");
      const detail = component.render(120).join("\n");
      assert.match(detail, /\bclosed\b/);
      assert.doesNotMatch(detail, new RegExp(`\\b${state}\\b`));
      assert.equal(agent.state, state);
      component.dispose();
    }

    const widgets: Array<string[] | undefined> = [];
    const controller = new UIController();
    controller.bind({ ui: { setStatus() {}, setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines) } } as never);
    controller.update({
      mainAddress: "main@test",
      agents: closedStates.map((state) => { const agent = record(); agent.state = state; return agent; }),
      unanswered: 0,
      queuedMail: 0,
      capacity: { identitiesUsed: 1, identitiesLimit: 1, runSlotsUsed: 0, runSlotsLimit: 1 },
    });
    assert.match((widgets.at(-1) ?? []).join("\n"), /3 closed/);
    assert.match((widgets.at(-1) ?? []).join("\n"), /identity capacity 1\/1 FULL.*run slots 0\/1/);
    assert.doesNotMatch((widgets.at(-1) ?? []).join("\n"), /paused|stopped|archived/);
    controller.clear();
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
        capacity: TEST_CAPACITY,
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

  it("renders work-first list/detail, exact-path warnings and bounded diff view", () => {
    const first = record(); const second = record(); second.address = "writer.same-path@gpt-5.4-mini.com";
    first.tools.push("edit"); second.tools.push("write");
    first.work = emptyWorkState(); second.work = emptyWorkState();
    first.work.currentBatchId = 1; second.work.currentBatchId = 1;
    const activeEdit = startWorkItem("e", "edit", { path: "src/ui.ts", edits: [{ oldText: "x", newText: "y" }] }, 1, "/work")!;
    const activeWrite = startWorkItem("w", "write", { path: "src/ui.ts", content: "private body" }, 1, "/work")!;
    first.work.active.push(activeEdit); second.work.active.push(activeWrite);
    const completed = finishWorkItem({ ...activeEdit, toolCallId: "done" }, { details: { patch: "--- a/src/ui.ts\n+++ b/src/ui.ts\n-old\n+new" } }, false);
    first.work.recent.push(completed);
    const snapshot = { mainAddress: "main@test.com", agents: [first, second], unanswered: 0, queuedMail: 0, capacity: TEST_CAPACITY };
    let action: { kind: string; workItem?: unknown } | undefined;
    const component = new DashboardComponent(() => snapshot, () => [], (next) => { action = next; }, () => undefined, fakeTheme, undefined, undefined, 12);
    for (const width of [20, 40, 80, 120]) {
      const lines = component.render(width);
      assert.ok(lines.length <= 12);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      if (width >= 80) assert.match(lines.join("\n"), /conflict|concurrent/i);
      assert.doesNotMatch(lines.join("\n"), /private body/);
    }
    first.work.active = [];
    second.work.active = [];
    component.handleInput("\r");
    component.handleInput("d");
    assert.equal(action?.kind, "diff");
    const diff = new WorkDiffComponent(first.address, completed, () => undefined, () => undefined, fakeTheme, 8);
    for (const width of [20, 40, 80, 120]) {
      const lines = diff.render(width);
      assert.ok(lines.length <= 8);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    let rows = 7;
    const unknown = { ...completed, linesAdded: undefined, linesRemoved: undefined, patchPreview: Array.from({ length: 30 }, (_, index) => `+line${index}`).join("\n") };
    const resizing = new WorkDiffComponent(first.address, unknown, () => undefined, () => undefined, fakeTheme, () => rows);
    const short = resizing.render(80); assert.match(short.join("\n"), /patch stats unknown/);
    rows = 12; resizing.invalidate(); const tall = resizing.render(80); assert.ok(tall.length > short.length);
  });

  it("renders structurally unknown mutation evidence as unverified rather than failed or confirmed", () => {
    const agent = record();
    agent.work = emptyWorkState();
    agent.work.currentBatchId = 4;
    const at = new Date().toISOString();
    agent.work.recent.push({
      toolCallId: "orphan-edit",
      batchId: 4,
      toolName: "edit",
      kind: "edit",
      attribution: "unverified",
      status: "unknown",
      startedAt: at,
      endedAt: at,
      observedResult: "success",
      reasonCode: "orphan-result",
    });
    const snapshot = { mainAddress: "main", agents: [agent], unanswered: 0, queuedMail: 0, capacity: TEST_CAPACITY };
    const component = new DashboardComponent(() => snapshot, () => [], () => undefined, () => undefined, fakeTheme, undefined, undefined, 20);
    component.handleInput("\r");
    const rendered = component.render(120).join("\n");
    assert.match(rendered, /Unverified effects/);
    assert.match(rendered, /effect unknown\/unverified.*observed success.*orphan-result/i);
    assert.doesNotMatch(rendered, /Confirmed and attempted mutations/);
    component.dispose();
  });

  it("sanitizes unsafe live path metadata in dashboard, widget, and diff", () => {
    const agent = record(); agent.work = emptyWorkState();
    const unsafe = startWorkItem("unsafe", "edit", { path: "safe", edits: [] }, 1, "/work")!;
    unsafe.displayPath = "bad\u001b]0;title\u0007\n\u202efile"; unsafe.toolName = "edit\t\u001b[31m"; agent.work.active.push(unsafe);
    const snapshot = { mainAddress: "main", agents: [agent], unanswered: 0, queuedMail: 0, capacity: TEST_CAPACITY };
    const component = new DashboardComponent(() => snapshot, () => [], () => undefined, () => undefined, fakeTheme);
    const rendered = component.render(80).join("\n"); assert.doesNotMatch(rendered, /\u001b\]|\u0007|\u202e/); component.dispose();
    const widgets: Array<string[] | undefined> = [];
    const controller = new UIController(); controller.bind({ ui: { setStatus() {}, setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines) } } as never); controller.update(snapshot);
    assert.doesNotMatch((widgets.at(-1) ?? []).join("\n"), /\u001b|\u0007|\u202e/); controller.clear();
    const terminal = finishWorkItem({ ...unsafe, toolName: "edit" }, { details: { patch: "+safe\u001b]0;pwn\u0007" } }, false);
    const diff = new WorkDiffComponent(agent.address, terminal, () => undefined, () => undefined, fakeTheme, 8);
    assert.doesNotMatch(diff.render(80).join("\n"), /\u001b\]|\u0007|\u202e/);
  });

  it("keeps long agent and work selections visible in short viewports", () => {
    const agents = Array.from({ length: 10 }, (_, index) => { const value = record(); value.address = `worker.task-${index}@gpt-5.4-mini.com`; return value; });
    let action: { kind: string; address?: string } | undefined;
    const list = new DashboardComponent(() => ({ mainAddress: "main@test", agents, unanswered: 0, queuedMail: 0, capacity: TEST_CAPACITY }), () => [], (next) => { action = next; }, () => undefined, fakeTheme, undefined, undefined, 10);
    for (let index = 0; index < 9; index++) list.handleInput("\x1b[B");
    assert.match(list.render(80).join("\n"), /task-9/);
    list.handleInput("k"); assert.equal(action?.address, agents[9]!.address); list.dispose();

    const agent = record(); agent.work = emptyWorkState(); agent.work.currentBatchId = 1;
    for (let index = 0; index < 30; index++) {
      const start = startWorkItem(`id${index}`, "edit", { path: `file-${index}.ts`, edits: [] }, 1, "/work")!;
      agent.work.recent.push(finishWorkItem(start, { details: { patch: `@@ -1 +1 @@\n-${index}\n+${index + 1}` } }, false));
    }
    const detail = new DashboardComponent(() => ({ mainAddress: "main@test", agents: [agent], unanswered: 0, queuedMail: 0, capacity: TEST_CAPACITY }), () => [], () => undefined, () => undefined, fakeTheme, undefined, undefined, 12);
    detail.handleInput("\r"); for (let index = 0; index < 29; index++) detail.handleInput("\x1b[B");
    assert.match(detail.render(80).join("\n"), /file-0\.ts/); // recent visual order is newest to oldest
    detail.dispose();
  });

  it("bounds a 64-agent by 48-item heavy ledger render", () => {
    const agents = Array.from({ length: 64 }, (_, agentIndex) => {
      const agent = record(); agent.address = `worker.stress-${agentIndex}@gpt-5.4-mini.com`; agent.work = emptyWorkState(); agent.work.currentBatchId = 1;
      for (let itemIndex = 0; itemIndex < 48; itemIndex++) {
        const item = finishWorkItem(startWorkItem(`a${agentIndex}-${itemIndex}`, "edit", { path: `f${itemIndex}`, edits: [] }, 1, "/work")!, { details: { patch: `@@ -1 +1 @@\n-${"x".repeat(4_000)}\n+${"y".repeat(4_000)}` } }, false);
        agent.work.recent.push(item);
      }
      return agent;
    });
    const component = new DashboardComponent(() => ({ mainAddress: "main", agents, unanswered: 0, queuedMail: 0, capacity: TEST_CAPACITY }), () => [], () => undefined, () => undefined, fakeTheme, undefined, undefined, 12);
    const lines = component.render(80); assert.ok(lines.length <= 12); assert.ok(lines.every((line) => visibleWidth(line) <= 80)); component.dispose();
  });

  it("refreshes active durations and disposes its timer", async () => {
    const agent = record(); agent.work = emptyWorkState(); agent.work.active.push(startWorkItem("x", "edit", { path: "x", edits: [] }, 1, "/work")!);
    let renders = 0;
    const component = new DashboardComponent(() => ({ mainAddress: "main", agents: [agent], unanswered: 0, queuedMail: 0, capacity: TEST_CAPACITY }), () => [], () => undefined, () => { renders += 1; }, fakeTheme);
    await new Promise((resolve) => setTimeout(resolve, 1_050)); assert.ok(renders >= 1);
    component.dispose(); const stopped = renders; await new Promise((resolve) => setTimeout(resolve, 1_050)); assert.equal(renders, stopped);
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
            { type: "toolCall", id: "write", name: "write", arguments: { path: "/tmp/write.ts", content: "RAW PRIVATE WRITE" } },
            { type: "toolCall", id: "edit", name: "edit", arguments: { path: "/tmp/edit.ts", edits: [{ oldText: "RAW OLD", newText: "RAW NEW" }] } },
            { type: "toolCall", id: "mail", name: "send_email", arguments: { to: "worker@test", subject: "safe", message: "MAIL_SENTINEL_SECRET" } },
            { type: "toolCall", id: "custom", name: "custom_tool", arguments: { payload: "CUSTOM_SENTINEL_SECRET" } },
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
    assert.doesNotMatch(serialized, /RAW PRIVATE WRITE|RAW OLD|RAW NEW|MAIL_SENTINEL_SECRET|CUSTOM_SENTINEL_SECRET/);
    assert.match(serialized, /write\.ts.*bytes/);
    assert.match(serialized, /edit\.ts.*replacement block/);
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
