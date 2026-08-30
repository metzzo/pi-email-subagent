# wait_for_replies

Join already-sent response-required requests and wait for their outcomes. Main-thread only. Execution mode: **sequential** (it blocks the tool call, not the agents).

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `request_ids` | string[] | — | 1–32 request IDs returned by [`send_email`](send-email.md) (`correlationId`); duplicates are removed |
| `timeout_seconds` | integer | `120` | 0–3600; `0` collects immediately available results |
| `collect` | boolean | `true` | When true, claim queued low replies if collection wins; every active wait still observes ordinary-presentation ownership and urgent high wakeups |

## Behavior

- Every ID must reference a known, response-required email **sent by the main thread**; violations fail the whole call before waiting.
- Resolves as soon as every item reaches a terminal state, or when the timeout expires, or when the tool call is aborted. Shutdown of the broker also ends the wait with the latest states.
- With `collect: true`, the broker serializes collection with ordinary main presentation. If this active wait claims an already-queued correlated reply first, it atomically marks the reply delivered/original answered and returns the body without calling main `sendMessage`. A collection commit in flight holds timeout/abort until that boundary.
- Presentation ownership is one-directional and per wait in both collect modes. If ordinary presentation wins the live race, this active wait returns terminal answered/status but omits that reply envelope/body. A fresh deliberate wait invoked later may still retrieve the answered reply, which preserves restart and uncertain-presentation recovery.
- Low-priority main mail is not handed to Pi as a `followUp` while main is busy. It stays in the bounded durable mail queue. If unclaimed, a one-shot macrotask after Pi `agent_settled` rechecks the exact extension generation, broker, and idle state before presenting. The first delivery starts a new run, so a backlog may drain one message per settlement. Pending timers are cancelled on shutdown/reload. Low mail arriving while main is already idle is presented promptly.
- High-priority steering stays immediate. A correlated high reply ordinarily presents during any active wait, whether `collect` is true or false; it ends a multi-ID wait partial promptly, and that wait omits the already-presented high body rather than waiting for a slow sibling or timeout. A high reply that was already accepted and queued when a collecting wait starts is not claimed as low collection: it keeps ordinary high presentation ownership.
- **Presentation limit:** Pi 0.84.2 exposes `sendMessage()` and `appendEntry()` but no supported staged tool-result receipt, durable `sendMessage` append acknowledgement, or post-append callback. A collection can therefore commit the mail answer before this tool result is durably appended. Ordinary presentation can likewise diverge from the journal if the process crashes around `sendMessage`. The per-wait live-race rule is not crash-proof exactly-once or guaranteed eventual presentation. The mail journal remains authoritative; after restart or presentation uncertainty, inspect Conversation/mail and rejoin the stable request ID.
- When a wait ends with pending work, its collection registrations are released but each request remains durable and correlated. A later low reply stays broker-queued while main is busy and is offered to a new deliberate collector or flushed at `agent_settled`. No rejoin is needed merely as a keepalive.
- With `collect: false`, the wait never claims queued low replies. Low replies received while main is busy follow the deferred `agent_settled` path. Ordinary presentation still marks this wait's body ownership, and high-priority mail still steers and wakes a multi-ID wait promptly.

### Item states

| State | Terminal | Meaning |
|-------|:--------:|---------|
| `answered` | ✓ | Reply delivered; `reply` contains the full envelope unless ordinary presentation won this active wait's live race |
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

The first line is `complete` (all terminal), `timed out with pending work` (`timedOut: true` with pending items), or `partial` (an abort or correlated high ordinary presentation ended the window with pending items and `timedOut: false`). In either collect mode, the next line states the active-race ownership rule, later-rejoin recovery, and Pi 0.84.2 crash limitation. A partial result with an answered item whose body was ordinarily presented also explains the urgent-high wakeup. Broker shutdown with pending work preserves the existing `timedOut: true` structured contract. Every `timedOut: true` result that still has pending items adds bounded guidance that the requests remain correlated, ordinary delivery is attempted when available, and an immediate keepalive-style rejoin is unnecessary. Complete and abort-partial results do not show that timeout guidance. `details.result` carries the same terminal metadata, but request/reply bodies are deliberately replaced with a marker instead of duplicating potentially large content already represented in the tool text.

Reply text is bounded by Pi's 50 KB / 2000-line tool-output recommendation and a smaller internal payload budget that reserves framing overhead. If joined reply bodies do not fit, the result keeps their terminal states and IDs but omits excess bodies with instructions to call `wait_for_replies` again using smaller ID groups. The context-safe single-envelope limit ensures a one-ID call can retrieve its body.

Failures throw `Could not wait for replies: <reason>`, so Pi records a native failed tool execution (`isError: true`) for unknown IDs, replies instead of requests, requests not sent by main, too many IDs, or invalid parameters.

## Usage guidance

- Prefer this over polling `fetch_emails`, reading state files, or sending progress mail after delegating.
- Join several independent requests in one call (up to 32) to collect their replies in a single turn; one wait may last up to 3600 seconds and still returns early when all items become terminal.
- Treat a finite wait as a bounded synchronous observation window, not a keepalive. After a pending timeout, continue useful work or end the turn; a late low reply remains durable, can be claimed by a later collector while main is busy, and otherwise flushes at `agent_settled`. Rejoin after restart or uncertainty.
- Pending IDs may be joined again later when you deliberately need a fresh synchronous collection/status window. Rejoining immediately only to keep a request alive is unnecessary.
- If an answered reply body was omitted because ordinary presentation won this wait or to preserve output bounds, a later deliberate rejoin with that exact ID (or a smaller group) can retrieve it.
- Treat `failed`/`stopped`/`archived`/`paused` items as recovery signals. Inspect Work and Conversation, then explicitly restart the same identity only after accounting for possible effects; do not automatically restart, cancel, redelegate, switch providers, or resend the accepted envelope.
- Treat `cancelled` as an explicit administrative outcome, never as successful work or a substantive reply.
