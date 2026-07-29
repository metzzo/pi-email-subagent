import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { createWorkerMailTools } from "../../src/sdk-worker.ts";
import type { EmailEnvelope, SendEmailInput } from "../../src/types.ts";

const envelope: EmailEnvelope = {
  id: "mail_tool",
  from: "worker.tool@gpt-5.4.com",
  to: "main@gpt-5.4.com",
  subject: "Result",
  message: "Done",
  priority: "low",
  kind: "request",
  requiresResponse: true,
  createdAt: new Date().toISOString(),
  deliveryState: "queued",
};

describe("worker mail tools", () => {
  it("binds sender outside model-supplied arguments and reports acceptance", async () => {
    let input: SendEmailInput | undefined;
    const [send] = createWorkerMailTools({
      sendEmail: async (value) => {
        input = value;
        return {
          envelope,
          spawned: false,
          recipientDisposition: "main",
          correlationId: envelope.id,
          expectedReplySubject: "Re: [mail_tool] Result",
        };
      },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    const result = await send.execute(
      "tool-1",
      { to: envelope.to, subject: envelope.subject, message: envelope.message, priority: "low" },
      undefined,
      undefined,
      {} as never,
    );
    assert.deepEqual(input, { to: envelope.to, subject: envelope.subject, message: envelope.message, priority: "low" });
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Email accepted/);
    assert.match(text, /Correlation ID: mail_tool/);
    assert.match(text, /Expected reply subject: Re: \[mail_tool\] Result/);
    assert.equal(Object.hasOwn(input as object, "from"), false);
    const priority = (send.parameters as { properties: { priority: unknown } }).properties.priority;
    assert.deepEqual(priority, { type: "string", enum: ["high", "low"] });
  });

  it("throws failed sends so Pi records a native tool error", async () => {
    const [send] = createWorkerMailTools({
      sendEmail: async () => { throw new Error("mailbox unavailable"); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    await assert.rejects(
      send.execute(
        "tool-error",
        { to: envelope.to, subject: envelope.subject, message: envelope.message, priority: "low" },
        undefined,
        undefined,
        {} as never,
      ),
      /Email was not accepted: mailbox unavailable/,
    );
  });

  it("fetches only broker-provided unanswered mail", async () => {
    const [_, fetch] = createWorkerMailTools({
      sendEmail: async () => ({ envelope, spawned: false, recipientDisposition: "main", correlationId: envelope.id }),
      fetchEmails: () => ({ emails: [envelope], total: 2 }),
    });
    const result = await fetch.execute("tool-2", {}, undefined, undefined, {} as never);
    assert.match((result.content[0] as { text: string }).text, /UNANSWERED EMAILS \(1\)/);
    assert.match((result.content[0] as { text: string }).text, /mail_tool/);
    assert.match((result.content[0] as { text: string }).text, /Showing 1 of 2/);
  });

  it("bounds fetch output by Pi's byte and line recommendations", async () => {
    const manyLines = { ...envelope, message: Array.from({ length: 3_000 }, (_, index) => `line ${index}`).join("\n") };
    const [_, fetch] = createWorkerMailTools({
      sendEmail: async () => ({ envelope, spawned: false, recipientDisposition: "main", correlationId: envelope.id }),
      fetchEmails: () => ({ emails: [manyLines], total: 1 }),
    });
    const result = await fetch.execute("tool-bounded", {}, undefined, undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    assert.ok(Buffer.byteLength(text) <= DEFAULT_MAX_BYTES);
    assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
    assert.match(text, /Output truncated/);
    assert.match(text, /paging or smaller-group guidance/);
  });
});
