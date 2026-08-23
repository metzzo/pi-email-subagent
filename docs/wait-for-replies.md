# wait_for_replies

Join already-sent response-required requests and wait for their outcomes. Main-thread only. Execution mode: **sequential** (it blocks the tool call, not the agents).

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `request_ids` | string[] | — | 1–32 request IDs returned by [`send_email`](send-email.md) (`correlationId`); duplicates are removed |
| `timeout_seconds` | integer | `120` | 0–300; `0` collects immediately available results |
| `collect` | boolean | `true` | Suppress separate model turns for replies to these requests and return them here instead |

## Behavior

- Every ID must reference a known, response-required email **sent by the main thread**; violations fail the whole call before waiting.
- Resolves as soon as every item reaches a terminal state, or when the timeout expires, or when the tool call is aborted. Shutdown of the broker also ends the wait with the latest states.
- With `collect: true`, replies to the listed requests are journaled and marked delivered **without** triggering a main-thread turn; they are returned in the result items. A reply whose journal commit is still in flight holds the wait (including timeout/abort) until that boundary, so no reply is lost between collector and delivery.
- When a wait ends with pending work, its collection registrations are released but each request remains durable and correlated. A later reply follows the ordinary main delivery path and triggers a turn automatically (or is delivered after broker/session restoration). No rejoin is needed to keep the request alive. A new deliberate collector can still collect the reply instead if one is opened before it arrives.
- With `collect: false`, replies arrive as ordinary incoming mail turns as usual.

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

The first line is `complete` (all terminal), `timed out with pending work` (`timedOut: true` with pending items), or `partial` (an abort returned pending items with `timedOut: false`). Broker shutdown with pending work preserves the existing `timedOut: true` structured contract. Every `timedOut: true` result that still has pending items adds bounded guidance that the requests remain correlated, automatic delivery resumes when available, and an immediate keepalive-style rejoin is unnecessary. Complete and abort-partial results do not show that timeout guidance. `details.result` carries the same terminal metadata, but request/reply bodies are deliberately replaced with a marker instead of duplicating potentially large content already represented in the tool text.

Reply text is bounded by Pi's 50 KB / 2000-line tool-output recommendation and a smaller internal payload budget that reserves framing overhead. If joined reply bodies do not fit, the result keeps their terminal states and IDs but omits excess bodies with instructions to call `wait_for_replies` again using smaller ID groups. The context-safe single-envelope limit ensures a one-ID call can retrieve its body.

Failures throw `Could not wait for replies: <reason>`, so Pi records a native failed tool execution (`isError: true`) for unknown IDs, replies instead of requests, requests not sent by main, too many IDs, or invalid parameters.

## Usage guidance

- Prefer this over polling `fetch_emails`, reading state files, or sending progress mail after delegating.
- Join several independent requests in one call (up to 32) to collect their replies in a single turn.
- Treat a finite wait as a bounded synchronous observation window, not a keepalive. After a pending timeout, continue useful work or end the turn; a late reply is delivered automatically.
- Pending IDs may be joined again later when you deliberately need a fresh synchronous collection/status window. Rejoining immediately only to keep a request alive is unnecessary.
- If an answered reply body was omitted to preserve output bounds, rejoin with that exact ID or a smaller group to retrieve the already-arrived body.
- Treat `failed`/`stopped`/`archived`/`paused` items as recovery signals: retry the agent or redelegate the scope once, then report the blocker.
- Treat `cancelled` as an explicit administrative outcome, never as successful work or a substantive reply.
