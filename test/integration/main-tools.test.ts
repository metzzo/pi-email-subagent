import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { AgentBroker } from "../../src/broker.ts";
import { createMainCoordinationTools } from "../../src/main-tools.ts";
import type { EmailEnvelope, WaitForRepliesResult } from "../../src/types.ts";

function waitRequest(id: string, subject = id): EmailEnvelope {
  return {
    id,
    from: "main@gpt-5.4.com",
    to: "worker.task@gpt-5.4.com",
    subject,
    message: "request",
    priority: "low",
    kind: "request",
    requiresResponse: true,
    createdAt: "2026-08-23T00:00:00.000Z",
    deliveryState: "delivered",
  };
}

async function renderWait(result: WaitForRepliesResult, toolResultByteLimit = 40_000) {
  const broker = {
    toolResultByteLimit,
    waitForReplies: async () => result,
  } as unknown as AgentBroker;
  const wait = createMainCoordinationTools(() => broker)[1];
  return wait.execute(
    "wait-guidance",
    { request_ids: result.items.map((item) => item.requestId), timeout_seconds: 0, collect: true },
    undefined,
    undefined,
    {} as never,
  );
}

it("exposes inspection, reply joining, audited cancellation, and lifecycle control without a spawn tool", async () => {
  const tools = createMainCoordinationTools(() => undefined);
  assert.deepEqual(tools.map((tool) => tool.name), ["inspect_agent", "wait_for_replies", "cancel_request", "manage_agent"]);
  assert.equal(tools.some((tool) => tool.name.includes("spawn")), false);
  const wait = tools[1];
  assert.equal(wait.executionMode, "sequential");
  assert.match(wait.description, /bounded (observation|collection) window/i);
  assert.match(wait.description, /late replies.*delivered automatically/i);
  const waitGuidelines = wait.promptGuidelines ?? [];
  assert.match(waitGuidelines.join("\n"), /do not.*rejoin.*keep.*alive/i);
  assert.match(waitGuidelines.join("\n"), /deliberate synchronous.*(collection|status).*window/i);
  const waitParameters = wait.parameters as {
    properties: {
      request_ids: { minItems?: number; maxItems?: number };
      timeout_seconds: { default?: number; minimum?: number; maximum?: number };
      collect: { default?: boolean };
    };
  };
  assert.equal(waitParameters.properties.request_ids.minItems, 1);
  assert.equal(waitParameters.properties.request_ids.maxItems, 32);
  assert.equal(waitParameters.properties.timeout_seconds.default, 120);
  assert.equal(waitParameters.properties.timeout_seconds.minimum, 0);
  assert.equal(waitParameters.properties.timeout_seconds.maximum, 300);
  assert.equal(waitParameters.properties.collect.default, true);

  await assert.rejects(
    tools[0].execute(
      "inspect-unready",
      { address: "worker.task@gpt-5.4.com" },
      undefined,
      undefined,
      {} as never,
    ),
    /Could not inspect agent: Email broker is not ready/,
  );
  await assert.rejects(
    tools[2].execute(
      "cancel-unready",
      { request_id: "mail_abandoned", reason: "Owner abandoned the request." },
      undefined,
      undefined,
      {} as never,
    ),
    /Could not cancel request: Email broker is not ready/,
  );
  const action = (tools[3].parameters as { properties: { action: unknown } }).properties.action;
  assert.deepEqual(action, { type: "string", enum: ["stop", "restart", "archive", "clear_failure"] });
});

it("previews an initial effort override without spawning", async () => {
  let call: { address?: string; effort?: string } = {};
  const broker = {
    inspectAgent(address: string, effort?: string) {
      call = { address, effort };
      return {
        address,
        exists: false,
        wouldSpawn: true,
        capacityAvailable: true,
        modelId: "gpt-5.6-sol",
        provider: "openai-codex",
        effort: effort ?? "medium",
        role: "worker",
        tools: ["read", "bash", "edit", "write", "send_email", "fetch_emails"],
        writable: true,
        canSpawn: true,
        state: "new",
        queued: 0,
        unanswered: 0,
        pendingReplies: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        providerReady: "unknown",
        lifecycle: {
          spawnTimeoutMs: 30_000,
          promptAcceptanceTimeoutMs: 30_000,
          runTimeoutMs: 14_400_000,
          idleTimeoutMs: 900_000,
          abortTimeoutMs: 10_000,
          disposeTimeoutMs: 10_000,
          brokerShutdownTimeoutMs: 60_000,
        },
      };
    },
  } as unknown as AgentBroker;
  const [inspect] = createMainCoordinationTools(() => broker);
  const result = await inspect.execute(
    "inspect-effort",
    { address: "worker.deep@gpt-5.6-sol.com", effort: "xhigh" },
    undefined,
    undefined,
    {} as never,
  );
  assert.deepEqual(call, { address: "worker.deep@gpt-5.6-sol.com", effort: "xhigh" });
  assert.match((result.content[0] as { text: string }).text, /effort xhigh/);
  const effort = (inspect.parameters as {
    properties: { effort: { anyOf?: unknown[]; enum?: string[] } };
  }).properties.effort;
  const effortSchema = (effort.anyOf?.find((item) => (item as { enum?: string[] }).enum) ?? effort) as { enum?: string[] };
  assert.deepEqual(effortSchema.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

it("guides timed-out pending waits without changing exact structured results", async () => {
  const request = waitRequest("mail_pending", "Long-running delegated task");
  const pending: WaitForRepliesResult = {
    complete: false,
    timedOut: true,
    items: [{ requestId: request.id, state: "pending", request }],
  };
  const rendered = await renderWait(pending);
  const text = (rendered.content[0] as { text: string }).text;
  assert.match(text, /Replies: timed out with pending work/);
  assert.match(text, /pending requests remain correlated/i);
  assert.match(text, /later replies.*delivered automatically.*main/i);
  assert.match(text, /no immediate.*wait_for_replies.*keep.*alive/i);
  assert.match(text, /rejoin only.*deliberate synchronous.*(collection|status).*window/i);
  assert.match(text, /broker\/session restoration/i, "the same structured branch remains accurate during pending shutdown");
  assert.doesNotMatch(text, /request (expired|was lost)|reply already exists/i);

  const details = rendered.details as { result: WaitForRepliesResult };
  assert.equal(details.result.complete, false);
  assert.equal(details.result.timedOut, true);
  assert.deepEqual(details.result.items.map((item) => [item.requestId, item.state]), [[request.id, "pending"]]);
  assert.equal(details.result.items[0]?.request?.message, "[body omitted from structured tool details; see tool text]");
});

it("omits timeout guidance for complete, terminal, and abort-partial results", async () => {
  const answeredRequest = waitRequest("mail_answered", "Answered task");
  const answeredReply = {
    ...waitRequest("reply_answered", `Re: [${answeredRequest.id}] ${answeredRequest.subject}`),
    from: answeredRequest.to,
    to: answeredRequest.from,
    message: "Done.",
    kind: "reply" as const,
    inReplyTo: answeredRequest.id,
    requiresResponse: false,
  };
  const cases: WaitForRepliesResult[] = [
    {
      complete: true,
      timedOut: false,
      items: [{ requestId: answeredRequest.id, state: "answered", request: answeredRequest, reply: answeredReply }],
    },
    {
      complete: true,
      timedOut: false,
      items: [{ requestId: "mail_failed", state: "failed", request: waitRequest("mail_failed"), error: "Agent failed." }],
    },
    {
      complete: false,
      timedOut: false,
      items: [{ requestId: "mail_aborted", state: "pending", request: waitRequest("mail_aborted") }],
    },
  ];
  for (const result of cases) {
    const rendered = await renderWait(result);
    const text = (rendered.content[0] as { text: string }).text;
    assert.doesNotMatch(text, /pending requests remain correlated/i);
    assert.doesNotMatch(text, /keep.*alive/i);
    if (!result.complete) assert.match(text, /Replies: partial/);
  }
});

it("keeps timeout guidance and exact IDs within output bounds for the largest normal join", async () => {
  const items = Array.from({ length: 32 }, (_, index) => {
    const id = `mail_pending_${String(index).padStart(2, "0")}`;
    const request = waitRequest(id, `Task ${index} ${"界".repeat(160)}`);
    return { requestId: id, state: "pending" as const, request };
  });
  const rendered = await renderWait({ complete: false, timedOut: true, items });
  const text = (rendered.content[0] as { text: string }).text;
  assert.match(text, /pending requests remain correlated/i);
  assert.match(text, /no immediate.*wait_for_replies/i);
  for (const item of items) assert.match(text, new RegExp(item.requestId));
  assert.ok(Buffer.byteLength(text) <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  const details = rendered.details as { result: WaitForRepliesResult };
  assert.deepEqual(details.result.items.map((item) => item.requestId), items.map((item) => item.requestId));
});

it("bounds joined reply bodies and directs callers to re-fetch omitted IDs", async () => {
  const request = (id: string): EmailEnvelope => ({
    id,
    from: "main@gpt-5.4.com",
    to: "worker.task@gpt-5.4.com",
    subject: id,
    message: "request",
    priority: "low",
    kind: "request",
    requiresResponse: true,
    createdAt: new Date().toISOString(),
    deliveryState: "delivered",
  });
  const items = ["mail_one", "mail_two"].map((id) => {
    const original = request(id);
    return {
      requestId: id,
      state: "answered" as const,
      request: original,
      reply: {
        ...request(`reply_${id}`),
        from: original.to,
        to: original.from,
        subject: `Re: [${id}] ${id}`,
        message: "x".repeat(180),
        kind: "reply" as const,
        inReplyTo: id,
        requiresResponse: false,
      },
    };
  });
  const result: WaitForRepliesResult = { complete: true, timedOut: false, items };
  const broker = {
    toolResultByteLimit: 300,
    waitForReplies: async () => result,
  } as unknown as AgentBroker;
  const tools = createMainCoordinationTools(() => broker);
  const rendered = await tools[1].execute(
    "wait-bounded",
    { request_ids: ["mail_one", "mail_two"], timeout_seconds: 0, collect: true },
    undefined,
    undefined,
    {} as never,
  );
  const text = (rendered.content[0] as { text: string }).text;
  assert.match(text, /reply body omitted/);
  assert.match(text, /call wait_for_replies again with only mail_/);
  assert.ok(Buffer.byteLength(text) < 1_000, "summary remains bounded even when reply bodies are omitted");
  assert.ok(Buffer.byteLength(text) <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  const details = rendered.details as { result: WaitForRepliesResult };
  assert.equal(details.result.items[0]?.request?.message, "[body omitted from structured tool details; see tool text]");
  assert.equal(details.result.items[0]?.reply?.message, "[body omitted from structured tool details; see tool text]");
});
