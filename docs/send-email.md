# send_email

Send virtual email to another Pi agent. Available to the main thread and to every subagent. Sender identity is automatic (the caller's own address); it cannot be spoofed. Execution mode: **parallel**.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `to` | string | ✓ | Recipient `<name>.<task-slug>@<model>.com`, or a main address `main@<model>.com` |
| `subject` | string | ✓ | New subject, or the exact reply subject `Re: [mail-id] original subject` from `fetch_emails` |
| `message` | string | ✓ | Self-contained request or substantive response |
| `priority` | `"high" \| "low"` | ✓ | Use `low` by default; `high` only for blockers that should change ongoing work |

## Behavior

### New mail

- An unknown valid recipient **spawns** a persistent agent (subject to `maxAgents`, default 8). An existing address reuses its persistent session.
- Sending to a `stopped` agent is accepted but stays queued (disposition `stopped`) until the agent is restarted. Sending to an `archived` agent restores it.
- Sending to yourself (including main → main aliases) is rejected.
- `low` mail is queued; `high` mail steers a streaming recipient immediately (and bypasses the per-recipient queue cap), otherwise it queues ahead of low mail.
- Replies are recognized solely by the subject shape `Re: [mail-id] …`. Subjects starting with `Re: [` that do not parse are rejected as malformed; plain subjects that merely start with `Re:` are valid new mail.

### Reply validation

Reply subjects are checked strictly, in order: the referenced email must exist, require a response, be unanswered, have no other reply pending delivery, and be delivered; the sender/recipient pair must match the original exactly; the original subject text must match byte-for-byte. A successful reply atomically reserves the obligation, and the original is marked answered when the reply is delivered. If reply delivery fails, the reservation is released and the requester is re-prompted.

### Limits (defaults; see [configuration.md](configuration.md))

- Subject: 512 bytes (+64 allowance for the reply prefix); no line breaks or control characters.
- Message: 32 KB; a single email may not exceed the 512 KB worker batch limit.
- Rate: 60 mails/minute global, 30 mails/minute per sender (sliding window). Validation failures are not charged; quota is consumed before journaling.
- Queue per recipient: 256 messages / 4 MB.

## Result

Success text (`isError: false`):

```text
Email accepted.
ID: mail_…
To: reviewer.audit@gpt-5.6-sol.com
Priority: low
Spawned recipient: no
Recipient disposition: reused
Delivery state: queued
Correlation ID: mail_…
Expected reply subject: Re: [mail_…] Audit token handling
Answered email: none
Recipient model: gpt-5.6-sol
Recipient effort: high
Recipient role: reviewer
Recipient tools: read, grep, find, ls, send_email, fetch_emails
Recipient state: running
```

`details.result` (`SendEmailResult`) fields:

| Field | Meaning |
|-------|---------|
| `envelope` | The stored envelope (id, from, to, subject, priority, kind, deliveryState, timestamps) |
| `spawned` | `true` when this send created the recipient |
| `recipientDisposition` | `main` \| `spawned` \| `reused` \| `restored` \| `stopped` |
| `correlationId` | Equals the envelope ID; use it with `wait_for_replies` |
| `expectedReplySubject` | Present for requests; the exact subject the recipient must answer with |
| `answeredEmailId` | Present when this send answered an earlier request |
| `recipientModel/Effort/Role/Tools/State` | Effective recipient profile (agents only) |

Failure text is `Email was not accepted: <reason>` with `isError: true` and `details.error`. Notable reasons: rate limit exceeded, agent limit reached, mailbox queue full, subject/message or formatted delivery too large, malformed reply subject, reply reference errors (unknown / already answered / pending / not delivered / wrong pair / subject mismatch), self-send, spawn-disabled sender role (`not permitted to spawn new agents`; reuse an existing address), unknown model or address shape. A send whose recipient-side delivery fails after journaling reports `Email <id> was persisted but delivery failed: …`.

If the tool call is aborted before acceptance, the result is `Email send aborted before acceptance.` and nothing is journaled.

## Usage guidance

- Make every delegation self-contained: objective, relevant paths, constraints, whether edits are allowed, expected response, and validation required.
- To answer mail, copy the exact reply subject returned by `fetch_emails` — never hand-construct or invent mail IDs.
- Use the returned `correlationId` with [`wait_for_replies`](wait-for-replies.md) instead of polling.
- Do not put new requests inside a reply; send a separate email with a new subject.
