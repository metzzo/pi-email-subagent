import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MailStore } from "../../src/mail-store.ts";
import type { EmailEnvelope } from "../../src/types.ts";

function email(id: string, priority: "high" | "low" = "low"): EmailEnvelope {
  return {
    id,
    from: "main@gpt-5.4.com",
    to: "worker.task@gpt-5.4.com",
    subject: id,
    message: "work",
    priority,
    kind: "request",
    requiresResponse: true,
    createdAt: new Date().toISOString(),
    deliveryState: "queued",
  };
}

describe("durable mail store", () => {
  it("persists creation, delivery, and atomic reply answer state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const path = join(root, "mail.jsonl");
    const store = new MailStore(path);
    await store.init();
    await store.accept(email("mail_first"));
    await store.markDelivered(["mail_first"]);
    const reply: EmailEnvelope = {
      ...email("mail_reply"),
      from: "worker.task@gpt-5.4.com",
      to: "main@gpt-5.4.com",
      subject: "Re: [mail_first] mail_first",
      kind: "reply",
      inReplyTo: "mail_first",
      requiresResponse: false,
    };
    await store.reserveReply(reply, "mail_first");
    assert.equal(store.get("mail_first")?.answeredBy, undefined);
    assert.equal(store.get("mail_first")?.replyReservedBy, "mail_reply");
    await store.markDelivered(["mail_reply"]);
    assert.equal(store.get("mail_first")?.answeredBy, "mail_reply");
    assert.deepEqual(store.unanswered("worker.task@gpt-5.4.com"), []);

    const restored = new MailStore(path);
    await restored.init();
    assert.equal(restored.get("mail_first")?.deliveryState, "delivered");
    assert.equal(restored.get("mail_first")?.answeredBy, "mail_reply");
  });

  it("atomically reserves one concurrent reply and reopens the obligation when delivery fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const path = join(root, "mail.jsonl");
    const store = new MailStore(path);
    await store.init();
    await store.accept(email("mail_original"));
    await store.markDelivered(["mail_original"]);
    const reply = (id: string): EmailEnvelope => ({
      ...email(id),
      from: "worker.task@gpt-5.4.com",
      to: "main@gpt-5.4.com",
      subject: "Re: [mail_original] mail_original",
      kind: "reply",
      inReplyTo: "mail_original",
      requiresResponse: false,
    });

    const attempts = await Promise.allSettled([
      store.reserveReply(reply("mail_reply_a"), "mail_original"),
      store.reserveReply(reply("mail_reply_b"), "mail_original"),
    ]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    const accepted = attempts[0]!.status === "fulfilled" ? "mail_reply_a" : "mail_reply_b";
    assert.equal(store.unanswered("worker.task@gpt-5.4.com").length, 0, "a reserved answer suppresses reminders");

    await store.markFailed(accepted, "main delivery unavailable");
    assert.equal(store.get("mail_original")?.replyReservedBy, undefined);
    assert.equal(store.unanswered("worker.task@gpt-5.4.com").length, 1);

    await store.reserveReply(reply("mail_reply_retry"), "mail_original");
    await store.markDelivered(["mail_reply_retry"]);
    assert.equal(store.get("mail_original")?.answeredBy, "mail_reply_retry");

    const restored = new MailStore(path);
    await restored.init();
    assert.equal(restored.get("mail_original")?.answeredBy, "mail_reply_retry");
  });

  it("durably cancels an abandoned obligation without fabricating an answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const path = join(root, "mail.jsonl");
    const store = new MailStore(path);
    await store.init();
    await store.accept(email("mail_abandoned"));
    await store.markDelivered(["mail_abandoned"]);

    const cancelled = await store.cancelRequest("mail_abandoned", "main@gpt-5.4.com", "Recipient was intentionally retired.");
    assert.equal(cancelled.deliveryState, "cancelled");
    assert.equal(cancelled.cancelledBy, "main@gpt-5.4.com");
    assert.equal(cancelled.cancellationReason, "Recipient was intentionally retired.");
    assert.ok(cancelled.cancelledAt);
    assert.equal(cancelled.answeredAt, undefined);
    assert.deepEqual(store.unanswered("worker.task@gpt-5.4.com"), []);

    await store.cancelRequest("mail_abandoned", "main@gpt-5.4.com", "A duplicate administrative attempt.");
    await store.markFailed("mail_abandoned", "late delivery failure");
    assert.equal(store.get("mail_abandoned")?.deliveryState, "cancelled");
    const events = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "email.cancelled").length, 1);

    const restored = new MailStore(path);
    await restored.init();
    assert.equal(restored.get("mail_abandoned")?.deliveryState, "cancelled");
    assert.equal(restored.get("mail_abandoned")?.cancellationReason, "Recipient was intentionally retired.");
    await restored.compact();
    const compacted = new MailStore(path);
    await compacted.init();
    assert.equal(compacted.get("mail_abandoned")?.cancelledBy, "main@gpt-5.4.com");
  });

  it("recovers a reply creation truncated before its reservation event", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const path = join(root, "mail.jsonl");
    const original = email("mail_partial_reservation");
    const reply: EmailEnvelope = {
      ...email("mail_partial_reply"),
      from: original.to,
      to: original.from,
      subject: "Re: [mail_partial_reservation] mail_partial_reservation",
      kind: "reply",
      inReplyTo: original.id,
      requiresResponse: false,
      deliveryState: "delivered",
      deliveredAt: new Date().toISOString(),
    };
    const at = new Date().toISOString();
    await appendFile(path, [
      { type: "email.created", email: original },
      { type: "email.delivered", id: original.id, at },
      { type: "email.created", email: reply },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const restored = new MailStore(path);
    await restored.init();
    assert.equal(restored.get(original.id)?.answeredBy, reply.id);
  });

  it("migrates legacy answers that were journaled before reply delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const path = join(root, "mail.jsonl");
    const original = email("mail_legacy");
    const reply: EmailEnvelope = {
      ...email("mail_legacy_reply"),
      from: original.to,
      to: original.from,
      subject: "Re: [mail_legacy] mail_legacy",
      kind: "reply",
      inReplyTo: original.id,
      requiresResponse: false,
    };
    const at = new Date().toISOString();
    await appendFile(path, [
      { type: "email.created", email: original },
      { type: "email.delivered", id: original.id, at },
      { type: "email.created", email: reply },
      { type: "email.answered", id: original.id, replyId: reply.id, at },
      { type: "email.delivered", id: reply.id, at },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const restored = new MailStore(path);
    await restored.init();
    assert.equal(restored.get(original.id)?.answeredBy, reply.id);
    assert.equal(restored.get(original.id)?.replyReservedBy, undefined);
  });

  it("rejects unknown journal event types instead of treating them as answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const path = join(root, "mail.jsonl");
    const first = new MailStore(path);
    await first.init();
    await first.accept(email("mail_known"));
    await appendFile(path, `${JSON.stringify({ type: "email.surprise", id: "mail_known", at: new Date().toISOString() })}\n`);
    const restored = new MailStore(path);
    await assert.rejects(restored.init(), /Corrupt mail journal.*unknown event type/i);
  });

  it("compacts the journal into a snapshot without losing state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const path = join(root, "mail.jsonl");
    const store = new MailStore(path);
    await store.init();
    await store.accept(email("mail_one"));
    await store.accept(email("mail_two"));
    await store.markDelivered(["mail_one", "mail_two"]);
    const reply: EmailEnvelope = {
      ...email("mail_reply"),
      from: "worker.task@gpt-5.4.com",
      to: "main@gpt-5.4.com",
      subject: "Re: [mail_one] mail_one",
      kind: "reply",
      inReplyTo: "mail_one",
      requiresResponse: false,
    };
    await store.reserveReply(reply, "mail_one");
    await store.markDelivered(["mail_reply"]);
    const before = store.list();

    assert.equal(await store.compactIfNeeded(1), true);
    await store.flush();
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, before.length);
    for (const line of lines) assert.match(line, /email\.created/);

    // Appends continue to work after compaction.
    await store.accept(email("mail_three"));

    const restored = new MailStore(path);
    await restored.init();
    assert.deepEqual(restored.list(), store.list());
    assert.equal(restored.get("mail_one")?.answeredBy, "mail_reply");
    assert.equal(restored.get("mail_two")?.deliveryState, "delivered");
    assert.equal(restored.get("mail_three")?.deliveryState, "queued");
    assert.equal(await restored.compactIfNeeded(1), false, "an already minimal snapshot is not rewritten repeatedly");
  });

  it("prunes oldest terminal mail while preserving every open obligation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const path = join(root, "mail.jsonl");
    const store = new MailStore(path);
    await store.init();
    for (let index = 0; index < 5; index += 1) {
      const item = email(`mail_terminal_${index}`);
      item.createdAt = new Date(Date.now() + index).toISOString();
      await store.accept(item);
      await store.markFailed(item.id, "terminal");
    }
    const open = email("mail_open");
    open.createdAt = new Date(Date.now() - 10_000).toISOString();
    await store.accept(open);
    await store.markDelivered([open.id]);

    assert.equal(await store.maintainIfNeeded(1, 3), true);
    assert.equal(store.get(open.id)?.deliveryState, "delivered");
    assert.equal(store.unanswered(open.to).some((item) => item.id === open.id), true);
    assert.equal(store.list().length, 3, "open mail plus the two newest terminal envelopes are retained");
    assert.deepEqual(store.list().filter((item) => item.id.startsWith("mail_terminal")).map((item) => item.id), [
      "mail_terminal_3", "mail_terminal_4",
    ]);

    const restored = new MailStore(path);
    await restored.init();
    assert.deepEqual(restored.list(), store.list());
  });

  it("retains answered request/reply pairs atomically during pruning", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const store = new MailStore(join(root, "mail.jsonl"));
    await store.init();
    for (const suffix of ["old", "new"]) {
      const original = email(`mail_pair_${suffix}`);
      original.createdAt = new Date(Date.now() + (suffix === "new" ? 10 : 0)).toISOString();
      await store.accept(original);
      await store.markDelivered([original.id]);
      const reply: EmailEnvelope = {
        ...email(`mail_pair_reply_${suffix}`),
        from: original.to,
        to: original.from,
        subject: `Re: [${original.id}] ${original.subject}`,
        kind: "reply",
        inReplyTo: original.id,
        requiresResponse: false,
        createdAt: new Date(Date.now() + (suffix === "new" ? 11 : 1)).toISOString(),
      };
      await store.reserveReply(reply, original.id);
      await store.markDelivered([reply.id]);
    }
    await store.maintainIfNeeded(1, 1);
    assert.deepEqual(store.list().map((item) => item.id), ["mail_pair_new", "mail_pair_reply_new"]);
    assert.equal(store.get("mail_pair_new")?.answeredBy, "mail_pair_reply_new");
  });

  it("sorts high priority before low while preserving FIFO", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const store = new MailStore(join(root, "mail.jsonl"));
    await store.init();
    await store.accept(email("mail_low", "low"));
    await store.accept(email("mail_high", "high"));
    await store.markDelivered(["mail_low", "mail_high"]);
    assert.deepEqual(store.unanswered("worker.task@gpt-5.4.com").map((item) => item.id), ["mail_high", "mail_low"]);
  });

  it("repairs a truncated final journal write before accepting more mail", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-email-mail-"));
    const path = join(root, "mail.jsonl");
    const first = new MailStore(path);
    await first.init();
    await first.accept(email("mail_before"));
    await appendFile(path, '{"type":"email.created","email":');

    const repaired = new MailStore(path);
    await repaired.init();
    await repaired.accept(email("mail_after"));
    const restored = new MailStore(path);
    await restored.init();
    assert.deepEqual(restored.list().map((item) => item.id), ["mail_before", "mail_after"]);
    assert.doesNotMatch(await readFile(path, "utf8"), /\"email\":$/m);
  });
});
