import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { AgentBroker } from "../../src/broker.ts";
import { createMainCoordinationTools } from "../../src/main-tools.ts";
import type { EmailEnvelope, WaitForRepliesResult } from "../../src/types.ts";

it("exposes inspection, reply joining, audited cancellation, and lifecycle control without a spawn tool", async () => {
  const tools = createMainCoordinationTools(() => undefined);
  assert.deepEqual(tools.map((tool) => tool.name), ["inspect_agent", "wait_for_replies", "cancel_request", "manage_agent"]);
  assert.equal(tools.some((tool) => tool.name.includes("spawn")), false);

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
