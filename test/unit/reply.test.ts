import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeReply, makeReplySubject, parseReplySubject } from "../../src/reply.ts";

describe("reply subjects", () => {
  it("round-trips exact reply metadata", () => {
    const subject = makeReplySubject("mail_abc_123", "Audit token handling");
    assert.equal(subject, "Re: [mail_abc_123] Audit token handling");
    assert.deepEqual(parseReplySubject(subject), { emailId: "mail_abc_123", originalSubject: "Audit token handling" });
  });

  it("recognizes malformed reply attempts without accepting them", () => {
    assert.equal(parseReplySubject("Re: Audit token handling"), undefined);
    assert.equal(looksLikeReply(" re : Audit token handling"), true);
  });
});
