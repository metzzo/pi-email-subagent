# wait_for_replies

Join already-sent response-required requests and wait for their outcomes. Main-thread only. Execution mode: **sequential** (it blocks the tool call, not the agents).

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `request_ids` | string[] | — | 1–32 request IDs returned by [`send_email`](send-email.md) (`correlationId`); duplicates are removed |
| `timeout_seconds` | integer | `120` | 0–3600; `0` collects immediately available results |
| `collect` | boolean | `true` | Suppress a separate live model turn and return replies here; this is at-most-one live presentation, not crash-proof exactly once |

## Behavior

- Every ID must reference a known, response-required email **sent by the main thread**; violations fail the whole call before waiting.
- Resolves as soon as every item reaches a terminal state, or when the timeout expires, or when the tool call is aborted. Shutdown of the broker also ends the wait with the latest states.
- With `collect: true`, the broker serializes collection with ordinary main presentation. It can atomically claim an already-queued correlated reply, mark the reply delivered and its original request answered, and return the reply here without calling main `sendMessage`. A reply whose collection claim is still committing holds timeout/abort until that boundary. In one live process, either collection or ordinary presentation wins.
- Low-priority main mail is not handed to Pi as a `followUp` while main is busy. It stays in the durable mail queue, where a later collector can claim it. If it remains unclaimed, the broker flushes it at Pi `agent_settled`; low mail arriving while main is already idle is presented promptly. High-priority steering is unchanged.
- **Presentation limit:** Pi 0.84.2 exposes `sendMessage()` and `appendEntry()` but no supported staged tool-result receipt, durable `sendMessage` append acknowledgement, or post-append callback. A collection can therefore commit the mail answer before this tool result is durably appended. Ordinary presentation can likewise diverge from the journal if the process crashes around `sendMessage`. Collection is at-most-one live presentation, not crash-proof exactly-once or guaranteed eventual presentation. The mail journal remains authoritative; after restart or presentation uncertainty, inspect Conversation/mail and rejoin the stable request ID.
- When a wait ends with pending work, its collection registrations are released but each request remains durable and correlated. A later low reply stays broker-queued while main is busy and is offered to a new deliberate collector or flushed at `agent_settled`. No rejoin is needed merely as a keepalive.
- With `collect: false`, low replies received while main is busy follow the same deferred `agent_settled` path; high-priority mail still steers immediately.

### Item states

| State | Terminal | Meaning |
|-------|:--------:|---------|
| `answered` | ✓ | Reply delivered; `reply` contains the full reply envelope |
| `failed` | ✓ | Request delivery failed, or the recipient agent failed (`error` has the diagnostic) |
| `cancelled` | ✓ | Main explicitly abandoned the exact request after its recipient became inactive; `error` carries the durable audit actor/reason |
| `stopped` | ✓ | Recipient is stopped |
| `archived` | ✓ | Recipient is archived |
| `paused` | ✓ | Recipient is paused by `maxAgents` capacity and has no live worker |
| `pending` | — | Still in flight when the wait ended |

## Result

```text
Replies: complete
- mail_…: answered · Audit token handling
  <full reply message>
- mail_…: failed · Refactor config loader · Agent failed: provider timeout
```

The first line is `complete` (all terminal), `timed out with pending work` (`timedOut: true` with pending items), or `partial` (an abort returned pending items with `timedOut: false`). With collection enabled, the next line always states the Pi 0.84.2 at-most-one live presentation limit and crash-recovery path. Broker shutdown with pending work preserves the existing `timedOut: true` structured contract. Every `timedOut: true` result that still has pending items adds bounded guidance that the requests remain correlated, ordinary delivery is attempted when available, and an immediate keepalive-style rejoin is unnecessary. Complete and abort-partial results do not show that timeout guidance. `details.result` carries the same terminal metadata, but request/reply bodies are deliberately replaced with a marker instead of duplicating potentially large content already represented in the tool text.

Reply text is bounded by Pi's 50 KB / 2000-line tool-output recommendation and a smaller internal payload budget that reserves framing overhead. If joined reply bodies do not fit, the result keeps their terminal states and IDs but omits excess bodies with instructions to call `wait_for_replies` again using smaller ID groups. The context-safe single-envelope limit ensures a one-ID call can retrieve its body.

Failures throw `Could not wait for replies: <reason>`, so Pi records a native failed tool execution (`isError: true`) for unknown IDs, replies instead of requests, requests not sent by main, too many IDs, or invalid parameters.

## Usage guidance

- Prefer this over polling `fetch_emails`, reading state files, or sending progress mail after delegating.
- Join several independent requests in one call (up to 32) to collect their replies in a single turn; one wait may last up to 3600 seconds and still returns early when all items become terminal.
- Treat a finite wait as a bounded synchronous observation window, not a keepalive. After a pending timeout, continue useful work or end the turn; a late low reply remains durable, can be claimed by a later collector while main is busy, and otherwise flushes at `agent_settled`. Rejoin after restart or uncertainty.
- Pending IDs may be joined again later when you deliberately need a fresh synchronous collection/status window. Rejoining immediately only to keep a request alive is unnecessary.
- If an answered reply body was omitted to preserve output bounds, rejoin with that exact ID or a smaller group to retrieve the already-arrived body.
- Treat `failed`/`stopped`/`archived`/`paused` items as recovery signals. Inspect Work and Conversation, then explicitly restart the same identity only after accounting for possible effects; do not automatically restart, cancel, redelegate, switch providers, or resend the accepted envelope.
- Treat `cancelled` as an explicit administrative outcome, never as successful work or a substantive reply.
