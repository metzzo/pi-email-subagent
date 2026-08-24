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
          recipientProvider: "provider-alpha",
          recipientModel: "shared",
          recipientEffort: "xhigh",
          correlationId: envelope.id,
          expectedReplySubject: "Re: [mail_tool] Result",
        };
      },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    const result = await send.execute(
      "tool-1",
      { to: envelope.to, subject: envelope.subject, message: envelope.message, priority: "low", effort: "xhigh" },
      undefined,
      undefined,
      {} as never,
    );
    assert.deepEqual(input, {
      to: envelope.to,
      subject: envelope.subject,
      message: envelope.message,
      priority: "low",
      effort: "xhigh",
    });
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Email accepted/);
    assert.match(text, /Correlation ID: mail_tool/);
    assert.match(text, /Expected reply subject: Re: \[mail_tool\] Result/);
    assert.match(text, /Recipient model: provider-alpha\/shared/);
    assert.match(text, /Binding: persisted for this identity/);
    assert.match(text, /Recipient effort: xhigh/);
    assert.equal(Object.hasOwn(input as object, "from"), false);
    const properties = (send.parameters as {
      properties: {
        priority: unknown;
        effort: { anyOf?: unknown[]; type?: string; enum?: string[] };
        lifecycle: { anyOf?: unknown[]; type?: string; properties?: Record<string, unknown> };
      };
    }).properties;
    assert.deepEqual(properties.priority, { type: "string", enum: ["high", "low"] });
    const effortSchema = (properties.effort.anyOf?.find((item) => (item as { enum?: string[] }).enum)
      ?? properties.effort) as { enum?: string[] };
    assert.deepEqual(effortSchema.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.ok(properties.lifecycle, "initial send schema exposes lifecycle");
    const lifecycleObject = (properties.lifecycle.anyOf?.find((item) => (item as { type?: string }).type === "object")
      ?? properties.lifecycle) as { properties?: Record<string, unknown> } | undefined;
    assert.deepEqual(lifecycleObject?.properties?.runTimeoutMs, {
      type: "integer", minimum: 1, maximum: 2_147_483_647,
    });
    assert.equal(lifecycleObject?.properties?.brokerShutdownTimeoutMs, undefined, "global shutdown is not delegable");
  });

  it("reports accepted queued mail to a failed recipient without contradiction", async () => {
    const failedEnvelope = { ...envelope, to: "worker.failed@gpt-5.4.com" };
    const [send] = createWorkerMailTools({
      sendEmail: async () => ({
        envelope: failedEnvelope,
        spawned: false,
        recipientDisposition: "failed",
        recipientState: "failed",
        correlationId: failedEnvelope.id,
      }),
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    const result = await send.execute(
      "tool-failed-recipient",
      { to: failedEnvelope.to, subject: failedEnvelope.subject, message: failedEnvelope.message, priority: "low" },
      undefined,
      undefined,
      {} as never,
    );
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Email accepted/);
    assert.match(text, /Spawned recipient: no/);
    assert.match(text, /Recipient disposition: failed/);
    assert.match(text, /Delivery state: queued/);
    assert.match(text, /accepted and queued.*remains failed.*no worker was spawned.*explicit manage_agent restart/is);
    assert.doesNotMatch(text, /not accepted/i);
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

  it("preserves bounded identity-capacity recovery diagnostics as a native send error", async () => {
    const diagnostic = "Agent limit reached: identity capacity is full (1/1 activation leases). Run concurrency is separate (0/1 slots currently used); waiting or stopping does not free an identity lease. Reuse a known address or ask main to archive a clean identity.";
    const [send] = createWorkerMailTools({
      sendEmail: async () => { throw new Error(diagnostic); },
      fetchEmails: () => ({ emails: [], total: 0 }),
    });
    await assert.rejects(
      send.execute(
        "tool-capacity",
        { to: "worker.new@gpt-5.4.com", subject: "Capacity", message: "No acceptance.", priority: "low" },
        undefined,
        undefined,
        {} as never,
      ),
      (error: Error) => {
        assert.match(error.message, /identity capacity.*1\/1.*activation leases/i);
        assert.match(error.message, /run concurrency.*0\/1/i);
        assert.match(error.message, /stopping.*does not free.*identity lease/i);
        assert.match(error.message, /ask main.*archive a clean identity/i);
        return true;
      },
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
