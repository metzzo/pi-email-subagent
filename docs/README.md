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
- Sending to a well-formed but unknown address **spawns** a persistent agent and durably binds the selected provider/model. The first send may override its initial effort from `off` through `max`; `inspect_agent` can preview both profile and routing selection without spawning. Sending to an existing address **reuses** its persistent session, context, effort, and exact original provider/model regardless of later main-provider changes. Reuse an identity only for continuing work in the same feature, worktree, or review-repair cycle, not for unrelated later phases or features. See [provider-aware durable model routing](provider-aware-model-routing.md).

### Priority and delivery

- `low` (default): queued and delivered in batches when a worker recipient settles. At most `maxBatchMessages` (32) or `maxBatchBytes` (512 KB) per delivery batch, high priority first, FIFO within a priority. For main, mail received while busy remains in the durable broker queue instead of becoming a Pi `followUp`; `wait_for_replies(collect:true)` may claim a correlated queued low reply, otherwise a one-shot macrotask after Pi `agent_settled` rechecks the exact session/broker/idle state before presenting. One delivery starts a new run, so a backlog may drain one per settlement. The main backlog is bounded across every current/historical alias. Individual envelopes and tool results remain within Pi's context-safe output recommendation.
- `high`: if a worker recipient is mid-run, the email **steers** it at the next safe agent boundary and is marked delivered immediately. For main, only a reply correlated with an open main request may interrupt a busy turn. Unsolicited high worker notifications/requests queue within the normal main bound. A correlated high reply ordinarily presents during an active multi-ID wait, ends it partial promptly, and is omitted from its tool body so the blocker is not duplicated.

### Reply protocol

Requests carry response obligations; worker→main new mail defaults to a notification unless `requires_response: true` is explicit. Replies use `reply_to` plus structured completion metadata, and the broker generates the canonical subject. The legacy exact-subject parser remains read-compatible. Obligations use a durable reserve → deliver → commit / release protocol, so concurrent replies cannot double-answer and failed delivery reopens the request. Legacy prose replies migrate as partial, and completed reports without recorded work or validation are warned. Final assistant text never becomes mail. Nested delegation is unsupported and pre-0.1 nested-request journals fail startup explicitly. If the user abandons work assigned to an inactive recipient, [`cancel_request`](cancel-request.md) closes that exact obligation with an audit reason without fabricating an answer.

### Durability

A cooperative proper-lockfile lease reduces accidental concurrent state writers within one parent-session namespace on the same local host/PID namespace; it is not a workspace or security fence. On Linux, complete owner boot ID, PID, `/proc` start time, and namespace path protect an exact live or `SIGSTOP`ed process. Owner transitions are serialized. When that exact prior owner is dead, startup automatically reclaims the stale lock, preserves mail/session/obligations, marks formerly active workers failed/inactive, and requires explicit same-identity restart. Missing, incomplete, malformed, mismatched, or publication-gap ownership remains fail-closed. On non-Linux hosts, an existing PID from incomplete metadata is only a blocking diagnostic, never exact-owner identity or reclaim authority; absent/unknown incomplete ownership also remains unreclaimable. On Linux, a successful boot/start mismatch establishes that the recorded exact generation is absent. Identity-read failure alone never does: every signal-0 result except `ESRCH` blocks as live/unverifiable, while only `ESRCH` confirms PID absence and may continue toward exact-dead recovery. Mail is journaled (`mail.jsonl`) before acceptance; the registry (`registry.json`) is a derived cache. Delivery across process crashes is **at least once**: stable email IDs let recipients recognize retries, and startup reconstructs a missing recipient record—including its accepted provider/model, lifecycle, and effort spawn intent—from queued mail when a crash lands between mail acceptance and first registry persistence. Queued main mail is recovered through the same busy/idle gate, and a pending settlement-flush timer is cancelled on shutdown/reload, so replacement does not recreate an early low `followUp`. Pi 0.84.2 still provides no durable acknowledgement that `sendMessage` appended its custom message; neither ordinary main presentation nor collected tool-result presentation is crash-proof exactly once. Live maintenance compacts excess transition events and prunes old terminal envelopes above `maxRetainedEmails` while preserving every open obligation and retained request/reply pair. Worker sessions persist under `~/.pi/agent/subagents/<parent-session-id>/` and resume across restarts.

### Lifecycle states and deadlines

`queued` → `spawning` → `running` ⇄ `idle`, plus `failed`, `stopped`, `paused` (restored over capacity), and `archived` (capacity freed, context retained). See [`manage_agent`](manage-agent.md) for transitions and [Agent lifecycle deadlines](lifecycle.md) for initial-delegation policy, watchdog, recovery, and shutdown semantics.

### Provider retry and terminal recovery

Pi core remains the only automatic retry owner. Workers surface **Pi agent retry** lifecycle through bounded Activity; provider/SDK attempts remain distinct, and retrying attempts neither fail the worker nor change the mail obligation. A final failure crosses one bounded sanitized shared boundary while protected raw detail stays in native Conversation, and every original obligation remains open. Inspect current-batch Work and Conversation before explicit same-identity/session/provider recovery because recorded effects may exist and an empty ledger is not proof of pre-tool safety. Never redelegate that possible-effect scope while its original obligation remains open. Failed mail stays queued for restart. Cleanup waits for Pi AgentSession/model/tool settlement and disposal, blocks only the exact address while pending, and does not claim OS descendant containment. See [Provider retry visibility and recovery](provider-retry-recovery.md) for settings isolation, option ownership, event ordering, attribution limits, and scrubbed escalation artifacts.

## Configuration

All limits, roles, address overrides, and the model-selection policy are configurable; see [configuration.md](configuration.md).

## Related surfaces

- [`/agents` work dashboard](agents-dashboard.md): live structured mutation intent/outcomes, exact-path warnings, inspection counters, bounded diffs, inbox/activity/profile tabs, lifecycle controls, and full conversation (`Ctrl+O`).
- `/agents stop|restart|archive|clear-failure|effort <address> …`: non-interactive equivalents of `manage_agent`.
- `/agents cancel <request-id> <reason>`: interactive equivalent of `cancel_request`; request IDs are visible in the Inbox tab.
- Main-session renderers: `send_email` results and incoming email cards expand (`Ctrl+O`) to show a bounded recent-conversation preview.
- [Provider-aware durable model routing](provider-aware-model-routing.md): new-vs-existing selection, binding intent, removal/reintroduction, and rollback boundary.
- [Release security checks](release-security-checks.md): secret scanning, production dependency-license policy, inventory artifacts, and action pinning.
