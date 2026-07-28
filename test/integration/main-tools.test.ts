import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentBroker } from "../../src/broker.ts";
import { createMainCoordinationTools } from "../../src/main-tools.ts";
import type { EmailEnvelope, WaitForRepliesResult } from "../../src/types.ts";

it("exposes inspection, reply joining, and lifecycle control without a spawn tool", async () => {
  const tools = createMainCoordinationTools(() => undefined);
  assert.deepEqual(tools.map((tool) => tool.name), ["inspect_agent", "wait_for_replies", "manage_agent"]);
  assert.equal(tools.some((tool) => tool.name.includes("spawn")), false);

  const result = await tools[0].execute(
    "inspect-unready",
    { address: "worker.task@gpt-5.4.com" },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match((result.content[0] as { text: string }).text, /broker is not ready/i);
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
});
