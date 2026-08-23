# send_email

Send virtual email to another Pi agent. Available to the main thread and to every subagent. Sender identity is automatic (the caller's own address); it cannot be spoofed. Execution mode: **parallel**.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `to` | string | ✓ | Recipient `<name>.<task-slug>@<model>.com`, or a main address `main@<model>.com` |
| `subject` | string | ✓ | New subject, or the exact reply subject `Re: [mail-id] original subject` from `fetch_emails` |
| `message` | string | ✓ | Self-contained request or substantive response |
| `priority` | `"high" \| "low"` | ✓ | Use `low` by default; `high` only for blockers that should change ongoing work |
| `effort` | `off`…`max` |  | Initial thinking level, accepted only for the first send to an unknown address |
| `lifecycle` | object |  | Partial finite lifecycle policy, accepted only for the first send to an unknown address |

## Behavior

### New mail

- An unknown valid recipient **spawns** a persistent agent (subject to `maxAgents`, default 8). An existing address reuses its persistent session.
- The first send may provide `effort` as `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It overrides exact-address, role, and default effort for the new identity. The accepted value is copied into durable spawn intent before worker creation; the runtime may clamp it only if the selected model lacks that level.
- The first send may provide any of `spawnTimeoutMs`, `promptAcceptanceTimeoutMs`, `runTimeoutMs`, `idleTimeoutMs`, `abortTimeoutMs`, and `disposeTimeoutMs` under `lifecycle`. Missing fields resolve from exact address → role → global finite defaults; configured administrative maxima reject oversized values. Broker shutdown is administrator-controlled global configuration and cannot be delegated.
- Later mail, including mail that restores an archived identity, must omit `effort` and `lifecycle` and preserve the identity's durable original values. This prevents silent mutation. Idle effort remains explicitly mutable through the dashboard or `/agents effort`; there is currently no lifecycle mutation action.
- Sending to a `stopped` agent is accepted but stays queued (disposition `stopped`) until the agent is restarted. Sending to an `archived` agent restores it.
- Sending to yourself (including main → main aliases) is rejected.
- `low` mail is queued; `high` mail steers a streaming recipient immediately (and bypasses the per-recipient queue cap), otherwise it queues ahead of low mail.
- Replies are recognized solely by the subject shape `Re: [mail-id] …`. Subjects starting with `Re: [` that do not parse are rejected as malformed; plain subjects that merely start with `Re:` are valid new mail.

### Reply validation

Reply subjects are checked strictly, in order: the referenced email must exist, require a response, be unanswered and not administratively cancelled, have no other reply pending delivery, and be delivered; the sender/recipient pair must match the original exactly; the original subject text must match byte-for-byte. A successful reply atomically reserves the obligation, and the original is marked answered when the reply is delivered. If reply delivery fails, the reservation is released and the requester is re-prompted.

### Mechanical completion replies

When a successful worker run settles with visible final assistant text but leaves a delivered request unanswered, the broker sends that text as the exact reply automatically. The generated reply uses the same durable reservation → delivery → commit protocol as an explicit `send_email`, so an explicit or already-reserved reply remains authoritative and cannot be duplicated. Oversized final text is UTF-8 safely truncated to `maxMessageBytes` with a notice.

If one settled batch contains unanswered requests from multiple senders, the broker sends an honest completion notice instead of forwarding combined text across sender boundaries. A truly silent run, failed automatic delivery, or terminal model error continues through the existing reminder/failure path rather than fabricating a result.

### Limits (defaults; see [configuration.md](configuration.md))

- Subject: 512 bytes (+64 allowance for the reply prefix); no line breaks or control characters.
- Message: 32 KB. After XML escaping, a single envelope must fit the context-safe tool payload budget (currently 48 KB and 1952 lines, or a lower configured `maxBatchBytes`) so it remains retrievable without truncating the task.
- Rate: 60 mails/minute global, 30 mails/minute per sender (sliding window). Validation failures are not charged; quota is consumed before journaling.
- Queue per recipient: 256 messages / 4 MB.

### Identity-capacity rejection and recovery

An identity-capacity error reports `maxAgents` activation leases used/limit and the separate current `maxConcurrent` run-slot use. A native `Email was not accepted: Agent limit reached …` result for an unknown recipient is a pre-accept rejection: no envelope, recipient record, or response obligation is created. A distinct `Email <id> was persisted but delivery failed: …` wrapper still means acceptance already occurred. The aggregate capacity diagnostic never lists other agent addresses, subjects, or bodies.

Waiting for a run slot or stopping an identity does not free its activation lease. Use the explicit recovery order: reuse a relevant existing address; restart stopped/failed real work; stop only to make an active identity inactive; cancel only an exact request the user explicitly abandoned and only after its recipient is inactive; archive a clean identity; then retry. Downstream agents cannot manage/cancel and should reuse a relevant address they already know or report the blocker to main.

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
Recipient lifecycle: {"spawnTimeoutMs":30000,...}
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
| `recipientModel/Effort/Role/Tools/State` | Effective recipient profile after model capability clamping (agents only) |
| `recipientLifecycle` | Exact persisted and enforced lifecycle policy (agents only) |

Failures are thrown from the tool with `Email was not accepted: <reason>`, so Pi records a native failed tool execution (`isError: true`). Notable reasons: rate limit exceeded, identity/activation capacity full (with separate run-slot use and safe recovery), mailbox queue full, subject/message or formatted delivery too large, invalid effort, effort/lifecycle override on an existing identity or main mail, malformed reply subject, reply reference errors (unknown / already answered / pending / not delivered / wrong pair / subject mismatch), self-send, spawn-disabled sender role (`not permitted to spawn new agents`; reuse an existing address), unknown model or address shape. A send whose recipient-side delivery fails after journaling reports `Email <id> was persisted but delivery failed: …`.

If the tool call is aborted before acceptance, the result is `Email send aborted before acceptance.` and nothing is journaled.

## Usage guidance

- Make every delegation self-contained: objective, relevant paths, constraints, whether edits are allowed, expected response, and validation required.
- To answer mail, copy the exact reply subject returned by `fetch_emails` — never hand-construct or invent mail IDs.
- Use the returned `correlationId` with [`wait_for_replies`](wait-for-replies.md) instead of polling.
- Do not put new requests inside a reply; send a separate email with a new subject.
