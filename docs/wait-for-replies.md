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
- With `collect: false`, replies arrive as ordinary incoming mail turns as usual.

### Item states

| State | Terminal | Meaning |
|-------|:--------:|---------|
| `answered` | ✓ | Reply delivered; `reply` contains the full reply envelope |
| `failed` | ✓ | Request delivery failed, or the recipient agent failed (`error` has the diagnostic) |
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

The first line is `complete` (all terminal), `timed out with pending work` (timeout with pending items), or `partial` (ended early with pending items, e.g. abort/shutdown). `details.result` (`WaitForRepliesResult`) carries `complete`, `timedOut`, and `items[]` with `requestId`, `state`, `request`, optional `reply`, and optional `error`.

Reply text is bounded by `maxBatchBytes`. If joined reply bodies do not fit, the result keeps their terminal states and IDs but omits excess bodies with instructions to call `wait_for_replies` again using smaller ID groups (a single ID retrieves its body).

Failure text is `Could not wait for replies: <reason>` with `isError: true` — unknown IDs, replies instead of requests, requests not sent by main, too many IDs, or an out-of-range timeout.

## Usage guidance

- Prefer this over polling `fetch_emails` or reading state files after delegating.
- Join several independent requests in one call (up to 32) to collect their replies in a single turn.
- Use a generous timeout for long tasks; `pending` items remain valid and can be joined again later with the same IDs.
- Treat `failed`/`stopped`/`archived`/`paused` items as recovery signals: retry the agent or redelegate the scope once, then report the blocker.
