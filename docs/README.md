# Subagent Tooling

`pi-email-subagent` gives a Pi session persistent parallel subagents coordinated through virtual email. This directory documents the tool surface in detail.

## Tool matrix

| Tool | Main thread | Subagents | Execution mode |
|------|:-----------:|:---------:|----------------|
| [`send_email`](send-email.md) | ✓ | ✓ | parallel |
| [`fetch_emails`](fetch-emails.md) | ✓ | ✓ | sequential |
| [`inspect_agent`](inspect-agent.md) | ✓ | — | parallel |
| [`wait_for_replies`](wait-for-replies.md) | ✓ | — | sequential |
| [`manage_agent`](manage-agent.md) | ✓ | — | sequential |

Workers always receive exactly `send_email` and `fetch_emails` on top of their configured role tools; the three coordination tools are main-thread only. `parallel` tools may run concurrently with other tool calls in the same turn; `sequential` tools run one at a time.

## Concepts

### Addressing

- Subagent: `<name>.<task-slug>@<model-id>.com` — e.g. `reviewer.audit@gpt-5.6-sol.com`. Name and slug are lowercase kebab-case; exactly one dot separates them.
- Main thread: `main@<model-id>.com`. It follows model switches; previous main addresses stay valid aliases.
- The model ID is resolved against Pi's available model catalog, case-insensitively. An ID offered by several providers is ambiguous and unroutable; `inspect_agent` and the system prompt list the routable IDs.
- Sending to a well-formed but unknown address **spawns** a persistent agent. Sending to an existing address **reuses** its persistent session and context.

### Priority and delivery

- `low` (default): queued and delivered in batches when the recipient settles. At most `maxBatchMessages` (32) or `maxBatchBytes` (512 KB) per delivery batch, high priority first, FIFO within a priority. Individual envelopes and mail-tool results remain within Pi's context-safe 50 KB / 2000-line output recommendation; `fetch_emails` pages independently when a delivery batch is larger. At most `maxConcurrent` (4) agents run at once; the rest wait in a fair queue that prioritizes aged (≥30 s) and high-priority mail.
- `high`: if the recipient is mid-run, the email **steers** it at the next safe agent boundary and is marked delivered immediately. Otherwise it is queued ahead of low mail.

### Reply protocol

Every request carries a response obligation. Replies must reuse the exact subject `Re: [mail-id] original subject`, which the broker validates strictly (existence, recipient/sender pair, exact subject text, single answer). Obligations are tracked with a durable reserve → deliver → commit / release protocol, so concurrent replies cannot double-answer and a failed reply delivery reopens the request. An agent that settles with unanswered mail is re-prompted (up to `responseReminderLimit`, default 2) and then marked failed.

### Durability

Mail is journaled (`mail.jsonl`) before acceptance; the registry (`registry.json`) is a derived cache. Delivery across process crashes is **at least once**: stable email IDs let recipients recognize retries, and startup reconstructs a missing recipient record from queued mail when a crash lands between mail acceptance and first registry persistence. Live maintenance compacts excess transition events and prunes old terminal envelopes above `maxRetainedEmails` while preserving every open obligation and retained request/reply pair. Worker sessions persist under `~/.pi/agent/subagents/<parent-session-id>/` and resume across restarts.

### Lifecycle states

`queued` → `spawning` → `running` ⇄ `idle`, plus `failed`, `stopped`, `paused` (restored over capacity), and `archived` (capacity freed, context retained). See [`manage_agent`](manage-agent.md) for transitions.

## Configuration

All limits, roles, address overrides, and the model-selection policy are configurable; see [configuration.md](configuration.md).

## Related surfaces

- `/agents` (or `Ctrl+Shift+A`): live dashboard — select, inspect inbox/activity, compose, stop, restart, archive, clear failure, change effort, and open the full recorded conversation (`Ctrl+O`).
- `/agents stop|restart|archive|clear-failure|effort <address> …`: non-interactive equivalents of `manage_agent`.
- Main-session renderers: `send_email` results and incoming email cards expand (`Ctrl+O`) to show a bounded recent-conversation preview.
