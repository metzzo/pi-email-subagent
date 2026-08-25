import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createLiveRpcState,
  finalizeLiveRun,
  readyForShutdownGrace,
  reduceLiveRpcEvent,
  type LiveExpectations,
  type LiveRpcState,
} from "../../scripts/live-e2e-support.ts";

const REQUEST_ID = "mail_request";
const REPLY_ID = "mail_reply";
const CREATED_AT = "2026-08-25T00:00:00.000Z";
const expectations: LiveExpectations = {
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  mainAddress: "main@gpt-5.6-sol.com",
  recipientAddress: "scout.live-mail@gpt-5.6-sol.com",
  subject: "Verify live mailbox",
};
const expectedReplySubject = `Re: [${REQUEST_ID}] ${expectations.subject}`;

function sendEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "tool_execution_end",
    toolName: "send_email",
    toolCallId: "call_send",
    isError: false,
    result: {
      details: {
        result: {
          correlationId: REQUEST_ID,
          recipientProvider: expectations.provider,
          recipientModel: expectations.modelId,
          expectedReplySubject,
          envelope: {
            id: REQUEST_ID,
            from: expectations.mainAddress,
            to: expectations.recipientAddress,
            subject: expectations.subject,
            message: "fixture request",
            priority: "low",
            kind: "request",
            requiresResponse: true,
            createdAt: CREATED_AT,
            deliveryState: "queued",
            modelBindingIntent: { provider: expectations.provider, modelId: expectations.modelId },
          },
          ...overrides,
        },
      },
    },
  };
}

function waitEvent(options: { complete?: boolean; timedOut?: boolean; requestId?: string; replyId?: string; state?: string } = {}): Record<string, unknown> {
  const requestId = options.requestId ?? REQUEST_ID;
  const replyId = options.replyId ?? REPLY_ID;
  return {
    type: "tool_execution_end",
    toolName: "wait_for_replies",
    toolCallId: "call_wait",
    isError: false,
    result: {
      details: {
        result: {
          complete: options.complete ?? true,
          timedOut: options.timedOut ?? false,
          items: [{
            requestId,
            state: options.state ?? "answered",
            reply: {
              id: replyId,
              from: expectations.recipientAddress,
              to: expectations.mainAddress,
              subject: expectedReplySubject,
              message: "fixture reply",
              priority: "low",
              kind: "reply",
              inReplyTo: requestId,
              requiresResponse: false,
              createdAt: CREATED_AT,
              deliveryState: "delivered",
            },
          }],
        },
      },
    },
  };
}

function settledRpc(events: Record<string, unknown>[] = []): LiveRpcState {
  const state = createLiveRpcState();
  for (const event of [
    { type: "response", command: "get_state", success: true, data: { sessionId: "session-fixture" } },
    { type: "response", command: "prompt", success: true },
    sendEvent(),
    waitEvent(),
    ...events,
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ]) reduceLiveRpcEvent(state, event, expectations);
  return state;
}

function registry(overrides: { provider?: string; modelId?: string; cleanup?: unknown; runSlotHeld?: boolean } = {}): Record<string, unknown> {
  return {
    version: 1,
    mainAddress: expectations.mainAddress,
    mainAliases: [expectations.mainAddress],
    agents: [{
      address: expectations.recipientAddress,
      name: "scout",
      taskSlug: "live-mail",
      provider: overrides.provider ?? expectations.provider,
      modelId: overrides.modelId ?? expectations.modelId,
      effort: "xhigh",
      tools: ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
      canSpawn: false,
      state: "paused",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      enforcementAttempts: 0,
      lifecycle: {
        spawnTimeoutMs: 30_000,
        promptAcceptanceTimeoutMs: 30_000,
        runTimeoutMs: 14_400_000,
        idleTimeoutMs: 900_000,
        abortTimeoutMs: 10_000,
        disposeTimeoutMs: 10_000,
        brokerShutdownTimeoutMs: 60_000,
      },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 },
      activity: [],
      work: { nextBatchId: 1, active: [], recent: [], inspection: { reads: 0, searches: 0, listings: 0 } },
      workerEpoch: {
        generation: 1,
        phase: "verified-clean",
        tools: ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
        mutationCapable: false,
        runSlotHeld: overrides.runSlotHeld ?? false,
      },
      ...(overrides.cleanup === undefined ? {} : { cleanup: overrides.cleanup }),
    }],
    updatedAt: CREATED_AT,
  };
}

function journal(options: { requestId?: string; replyId?: string } = {}): string {
  const requestId = options.requestId ?? REQUEST_ID;
  const replyId = options.replyId ?? REPLY_ID;
  const replySubject = `Re: [${requestId}] ${expectations.subject}`;
  const events = [
    { type: "email.created", email: {
      id: requestId,
      from: expectations.mainAddress,
      to: expectations.recipientAddress,
      subject: expectations.subject,
      message: "fixture request",
      priority: "low",
      kind: "request",
      requiresResponse: true,
      createdAt: CREATED_AT,
      deliveryState: "queued",
      modelBindingIntent: { provider: expectations.provider, modelId: expectations.modelId },
    } },
    { type: "email.delivered", id: requestId, at: CREATED_AT },
    { type: "email.created", email: {
      id: replyId,
      from: expectations.recipientAddress,
      to: expectations.mainAddress,
      subject: replySubject,
      message: "fixture reply",
      priority: "low",
      kind: "reply",
      inReplyTo: requestId,
      requiresResponse: false,
      createdAt: CREATED_AT,
      deliveryState: "queued",
    } },
    { type: "email.reply_reserved", id: requestId, replyId, at: CREATED_AT },
    { type: "email.delivered", id: replyId, at: CREATED_AT },
    { type: "email.answered", id: requestId, replyId, at: CREATED_AT },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

async function namespaceFixture(
  root: string,
  name: string,
  options: { registry?: unknown; journal?: string; owner?: boolean; lock?: boolean } = {},
): Promise<{ namespaceDir: string; evidenceDir: string }> {
  const namespaceDir = join(root, name);
  const evidenceDir = join(root, "evidence");
  await mkdir(namespaceDir, { recursive: true });
  await writeFile(join(namespaceDir, "registry.json"), `${JSON.stringify(options.registry ?? registry(), null, 2)}\n`);
  await writeFile(join(namespaceDir, "mail.jsonl"), options.journal ?? journal());
  if (options.owner) await writeFile(join(namespaceDir, ".broker-owner.json"), "{}\n");
  if (options.lock) await mkdir(`${namespaceDir}.lock`);
  return { namespaceDir, evidenceDir };
}

async function finalize(
  fixture: { namespaceDir: string; evidenceDir: string },
  options: { state?: LiveRpcState; childExitCode?: number | null; timedOut?: boolean } = {},
) {
  return finalizeLiveRun({
    state: options.state ?? settledRpc(),
    expectations,
    namespaceDir: fixture.namespaceDir,
    evidenceDir: fixture.evidenceDir,
    childExitCode: options.childExitCode ?? 0,
    timedOut: options.timedOut ?? false,
  });
}

describe("live provider RPC settlement reducer", () => {
  it("does not start shutdown grace when a reply arrives before the final main agent boundary", () => {
    const state = createLiveRpcState();
    reduceLiveRpcEvent(state, sendEvent(), expectations);
    reduceLiveRpcEvent(state, waitEvent(), expectations);
    assert.equal(readyForShutdownGrace(state), false);

    reduceLiveRpcEvent(state, { type: "agent_end", willRetry: false }, expectations);
    assert.equal(readyForShutdownGrace(state), false, "agent_end alone is not full settlement");

    reduceLiveRpcEvent(state, { type: "agent_settled" }, expectations);
    assert.equal(readyForShutdownGrace(state), true);
  });

  it("records an extension_error after the functional reply as a mandatory failure", async () => {
    const root = join(tmpdir(), `pi-live-extension-${process.pid}-${Date.now()}`);
    await mkdir(root, { recursive: true });
    try {
      const fixture = await namespaceFixture(root, "namespace");
      const result = await finalize(fixture, { state: settledRpc([{ type: "extension_error", event: "session_shutdown", error: "redacted fixture" }]) });
      assert.equal(result.ok, false);
      assert.match(result.reasons.join("\n"), /extension error/i);
      assert.equal(await readFile(join(fixture.namespaceDir, "registry.json"), "utf8").then(() => true), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("live provider namespace finalizer", () => {
  it("preserves cleanup quarantine, held run slots, and live ownership evidence", async () => {
    const root = join(tmpdir(), `pi-live-quarantine-${process.pid}-${Date.now()}`);
    await mkdir(root, { recursive: true });
    try {
      const cleanup = {
        state: "unknown",
        reasonCode: "cleanup-timeout",
        workerGeneration: 1,
        startedAt: CREATED_AT,
        updatedAt: CREATED_AT,
        abort: "timed-out",
        dispose: "succeeded",
        quiescence: "unknown",
        mutationCapableAtStart: false,
        heldRunSlot: false,
        activeTools: [],
      };
      const cases = [
        await namespaceFixture(root, "cleanup", { registry: registry({ cleanup }) }),
        await namespaceFixture(root, "held-slot", { registry: registry({ runSlotHeld: true }) }),
        await namespaceFixture(root, "owner", { owner: true }),
        await namespaceFixture(root, "lock", { lock: true }),
      ];
      for (const fixture of cases) {
        const result = await finalize(fixture);
        assert.equal(result.ok, false);
        assert.equal(result.preserved, true);
        assert.equal(await readFile(join(fixture.namespaceDir, "registry.json"), "utf8").then(() => true), true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves and validates clean evidence before removing a settled namespace", async () => {
    const root = join(tmpdir(), `pi-live-clean-${process.pid}-${Date.now()}`);
    await mkdir(root, { recursive: true });
    try {
      const fixture = await namespaceFixture(root, "namespace");
      const result = await finalize(fixture);
      assert.equal(result.ok, true, result.reasons.join("\n"));
      assert.equal(result.removed, true);
      assert.equal(result.evidenceValidated, true);
      assert.ok(result.evidencePath);
      const evidence = JSON.parse(await readFile(result.evidencePath!, "utf8")) as { clean?: boolean; requestId?: string; replyId?: string };
      assert.deepEqual({ clean: evidence.clean, requestId: evidence.requestId, replyId: evidence.replyId }, {
        clean: true,
        requestId: REQUEST_ID,
        replyId: REPLY_ID,
      });
      await assert.rejects(readFile(join(fixture.namespaceDir, "registry.json"), "utf8"), /ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for timeout, nonzero exit, tool error, duplicate send, incomplete reply, and malformed state or journal", async () => {
    const root = join(tmpdir(), `pi-live-failures-${process.pid}-${Date.now()}`);
    await mkdir(root, { recursive: true });
    try {
      const toolError = settledRpc([{ type: "tool_execution_end", toolName: "fetch_emails", toolCallId: "bad", isError: true, result: {} }]);
      const duplicateSend = settledRpc([sendEvent()]);
      const incomplete = createLiveRpcState();
      for (const event of [
        { type: "response", command: "get_state", success: true, data: { sessionId: "session-fixture" } },
        { type: "response", command: "prompt", success: true },
        sendEvent(),
        waitEvent({ complete: false, timedOut: true, state: "pending" }),
        { type: "agent_end", willRetry: false },
        { type: "agent_settled" },
      ]) reduceLiveRpcEvent(incomplete, event, expectations);

      const cases = [
        { name: "timeout", fixture: await namespaceFixture(root, "timeout"), options: { timedOut: true } },
        { name: "nonzero exit", fixture: await namespaceFixture(root, "nonzero"), options: { childExitCode: 9 } },
        { name: "tool error", fixture: await namespaceFixture(root, "tool-error"), options: { state: toolError } },
        { name: "duplicate send", fixture: await namespaceFixture(root, "duplicate-send"), options: { state: duplicateSend } },
        { name: "incomplete reply", fixture: await namespaceFixture(root, "incomplete"), options: { state: incomplete } },
        { name: "malformed registry", fixture: await namespaceFixture(root, "bad-registry", { registry: { version: 1 } }), options: {} },
        { name: "malformed journal", fixture: await namespaceFixture(root, "bad-journal", { journal: "{not json\n" }), options: {} },
      ];
      for (const testCase of cases) {
        const result = await finalize(testCase.fixture, testCase.options);
        assert.equal(result.ok, false, testCase.name);
        assert.equal(result.preserved, true, testCase.name);
        assert.ok(result.reasons.length > 0, testCase.name);
        assert.equal(await readFile(join(testCase.fixture.namespaceDir, "registry.json"), "utf8").then(() => true), true, testCase.name);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects mismatched stable correlation and expected provider/model binding", async () => {
    const root = join(tmpdir(), `pi-live-correlation-${process.pid}-${Date.now()}`);
    await mkdir(root, { recursive: true });
    try {
      const cases = [
        {
          name: "reply ID",
          fixture: await namespaceFixture(root, "reply-id", { journal: journal({ replyId: "mail_other_reply" }) }),
          state: settledRpc(),
        },
        {
          name: "provider",
          fixture: await namespaceFixture(root, "provider", { registry: registry({ provider: "wrong-provider" }) }),
          state: settledRpc(),
        },
        {
          name: "model",
          fixture: await namespaceFixture(root, "model", { registry: registry({ modelId: "wrong-model" }) }),
          state: settledRpc(),
        },
        {
          name: "RPC binding",
          fixture: await namespaceFixture(root, "rpc-binding"),
          state: (() => {
            const state = createLiveRpcState();
            for (const event of [
              { type: "response", command: "get_state", success: true, data: { sessionId: "session-fixture" } },
              { type: "response", command: "prompt", success: true },
              sendEvent({ recipientProvider: "wrong-provider" }),
              waitEvent(),
              { type: "agent_end", willRetry: false },
              { type: "agent_settled" },
            ]) reduceLiveRpcEvent(state, event, expectations);
            return state;
          })(),
        },
      ];
      for (const testCase of cases) {
        const result = await finalize(testCase.fixture, { state: testCase.state });
        assert.equal(result.ok, false, testCase.name);
        assert.equal(result.preserved, true, testCase.name);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
