# Subagent Tooling

`pi-email-subagent` gives a Pi session persistent parallel subagents coordinated through virtual email. This directory documents the tool surface in detail.

## Tool matrix

| Tool | Main thread | Subagents | Execution mode |
|------|:-----------:|:---------:|----------------|
| [`send_email`](send-email.md) | ✓ | ✓ | parallel |
| [`fetch_emails`](fetch-emails.md) | ✓ | ✓ | sequential |
| [`inspect_agent`](inspect-agent.md) | ✓ | — | parallel |
| [`wait_for_replies`](wait-for-replies.md) | ✓ | — | sequential |
| [`cancel_request`](cancel-request.md) | ✓ | — | sequential |
| [`manage_agent`](manage-agent.md) | ✓ | — | sequential |

Workers always receive exactly `send_email` and `fetch_emails` on top of their configured role tools; the four coordination tools are main-thread only. `parallel` tools may run concurrently with other tool calls in the same turn; `sequential` tools run one at a time.

## Concepts

### Addressing

- Subagent: `<name>.<task-slug>@<model-id>.com` — e.g. `reviewer.audit@gpt-5.6-sol.com`. Name and slug are lowercase kebab-case; exactly one dot separates them.
- Main thread: `main@<model-id>.com`. It follows model switches; previous main addresses stay valid aliases.
- The domain is a model ID, not a provider ID. A globally unique ID resolves directly for a new address. Duplicate IDs use the current main provider only when it identifies exactly one candidate; otherwise mail fails before acceptance.
- Sending to a well-formed but unknown address **spawns** a persistent agent and durably binds the selected provider/model. The first send may override its initial effort from `off` through `max`; `inspect_agent` can preview both profile and routing selection without spawning. Sending to an existing address **reuses** its persistent session, context, effort, and exact original provider/model regardless of later main-provider changes. See [provider-aware durable model routing](provider-aware-model-routing.md).

### Priority and delivery

- `low` (default): queued and delivered in batches when the recipient settles. At most `maxBatchMessages` (32) or `maxBatchBytes` (512 KB) per delivery batch, high priority first, FIFO within a priority. Individual envelopes and mail-tool results remain within Pi's context-safe 50 KB / 2000-line output recommendation; `fetch_emails` pages independently when a delivery batch is larger. At most `maxConcurrent` (4) agents run at once; the rest wait in a fair queue that prioritizes aged (≥30 s) and high-priority mail.
- `high`: if the recipient is mid-run, the email **steers** it at the next safe agent boundary and is marked delivered immediately. Otherwise it is queued ahead of low mail.

### Reply protocol

Every request carries a response obligation. Replies must reuse the exact subject `Re: [mail-id] original subject`, which the broker validates strictly (existence, recipient/sender pair, exact subject text, single answer). Obligations are tracked with a durable reserve → deliver → commit / release protocol, so concurrent replies cannot double-answer and a failed reply delivery reopens the request. If a successful worker finishes with visible final text but forgets `send_email`, the broker mechanically sends that text through the same reply protocol; truly silent or failed runs retain the reminder/failure path. If the user intentionally abandons work assigned to an inactive recipient, [`cancel_request`](cancel-request.md) durably closes that exact obligation with an audit reason without fabricating an answer.

### Durability

A proper-lockfile lease allows only one live broker to own a parent-session namespace. On Linux, owner boot ID plus `/proc` start time prevents stale-mtime takeover from an exact live or `SIGSTOP`ed process; only exact owner death can become an abandoned takeover after the 10-second stale threshold, and prior writable/restorable generations are quarantined before restore. Other platforms allow clean ownership but fail closed on abandoned takeover. Mail is journaled (`mail.jsonl`) before acceptance; the registry (`registry.json`) is a derived cache. Delivery across process crashes is **at least once**: stable email IDs let recipients recognize retries, and startup reconstructs a missing recipient record—including its accepted provider/model, lifecycle, and effort spawn intent—from queued mail when a crash lands between mail acceptance and first registry persistence. Live maintenance compacts excess transition events and prunes old terminal envelopes above `maxRetainedEmails` while preserving every open obligation and retained request/reply pair. Worker sessions persist under `~/.pi/agent/subagents/<parent-session-id>/` and resume across restarts.

### Lifecycle states and deadlines

`queued` → `spawning` → `running` ⇄ `idle`, plus `failed`, `stopped`, `paused` (restored over capacity), and `archived` (capacity freed, context retained). See [`manage_agent`](manage-agent.md) for transitions and [Agent lifecycle deadlines](lifecycle.md) for initial-delegation policy, watchdog, recovery, and shutdown semantics.

### Provider retry and terminal recovery

Pi core remains the only automatic retry owner. Workers surface Pi retry lifecycle through existing bounded Activity; retrying attempts neither fail the worker nor change the mail obligation. A final failure keeps the accepted request open. Inspect current-batch Work and native Conversation before an explicit same-identity restart because recorded effects may exist and an empty ledger is not proof of pre-tool safety. See [Provider retry visibility and recovery](provider-retry-recovery.md) for effective trusted settings, event ordering, attribution limits, and scrubbed escalation artifacts.

## Configuration

All limits, roles, address overrides, and the model-selection policy are configurable; see [configuration.md](configuration.md).

## Related surfaces

- [`/agents` work dashboard](agents-dashboard.md): live structured mutation intent/outcomes, exact-path warnings, inspection counters, bounded diffs, inbox/activity/profile tabs, lifecycle controls, and full conversation (`Ctrl+O`).
- `/agents stop|restart|archive|clear-failure|effort <address> …`: non-interactive equivalents of `manage_agent`.
- `/agents cancel <request-id> <reason>`: interactive equivalent of `cancel_request`; request IDs are visible in the Inbox tab.
- Main-session renderers: `send_email` results and incoming email cards expand (`Ctrl+O`) to show a bounded recent-conversation preview.
- [Provider-aware durable model routing](provider-aware-model-routing.md): new-vs-existing selection, binding intent, removal/reintroduction, and rollback boundary.
- [Release security checks](release-security-checks.md): secret scanning, production dependency-license policy, inventory artifacts, and action pinning.
