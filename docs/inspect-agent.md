# inspect_agent

Preview or inspect an agent address without spawning it. Main-thread only. Execution mode: **parallel**.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `address` | string | ✓ | Subagent address to inspect or preview (existing or prospective) |
| `effort` | `off`…`max` |  | Preview this initial effort for a prospective unknown identity |

## Behavior

- Never spawns. For an unknown (but valid) address it computes the *effective* profile and prospective provider/model selection the agent would receive. One global model candidate resolves directly; duplicate IDs require exactly one match under the current main provider. A supplied `effort` previews the initial-send override; otherwise effort resolves exact address → role → default. Model capability clamping occurs only when the worker runtime is created.
- Existing identities show their persisted exact provider/model and ignore current main preference. Persisted identities whose exact tuple is no longer available remain inspectable as failed/unavailable records, explicitly report no substitution, do not prevent unrelated restoration, and consume no ordinary activation lease (cleanup quarantine ownership remains fail-closed).
- Every address must have valid syntax. A prospective address must also resolve under new-identity rules; otherwise the tool returns an error result with no side effects. An existing unavailable address remains inspectable from its record.
- `effort` is rejected for an existing identity because inspection is read-only and later mail cannot mutate persisted effort. Use `/agents effort` or the dashboard while that agent is idle.
- `writable` is derived from the effective tools: `true` when they include any of `bash`, `edit`, `write`. Role labels alone grant nothing.

## Result

```text
Existing agent: reviewer.audit@gpt-5.6-sol.com
State: idle
Model: openai/gpt-5.6-sol · effort high
Binding: persisted exact provider/model · existing identity ignores current main-provider preference
Role: reviewer · read-only · delegation disabled
Tools: read, grep, find, ls, send_email, fetch_emails
Identity capacity: 8/8 used · this address holds a lease: yes · capacity available for this address: yes
Run concurrency: 2/4 slots used
Mailbox: 0 queued · 1 incoming unanswered · 1 outgoing unanswered · 0 pending replies
Archive eligible: no
Archive blockers: incoming unanswered 1 (mail_…) · outgoing unanswered 1 (mail_…)
Recovery: restart this inactive identity to finish real obligations; cancel only an explicitly abandoned exact request; archive only after blockers are clear.
Lifecycle: {"spawnTimeoutMs":30000,...}
Cleanup: unknown · quiescence unknown · activation held · restart/archive blocked · queued mail preserved
Cleanup phases: abort succeeded · dispose succeeded · generation 7 · mutation-capable at start yes · run slot held no
Last failure: …            (only when present)
Terminal worker run failure · openai/gpt-5.6-sol · provider/network cause may be external or unclear.
1 delivered request remains unanswered. Current batch includes mutation/shell/custom work; effects may exist.
Inspect Work and Conversation before explicit same-identity restart.
```

The terminal recovery lines appear only when the existing activity/failure state identifies a completed failed agent run. They are derived at render time from the existing provider/model binding, incoming obligation count, and current-batch work cache; no provider-diagnostic field is added to `details.inspection`. If no current-batch mutation/shell/custom item is recorded, the tool explicitly says that this is not proof of pre-tool failure and directs the operator to the native Conversation before restart.

`details.inspection` (`AgentInspection`) fields:

| Field | Meaning |
|-------|---------|
| `exists` / `wouldSpawn` | Whether a record exists; whether a send would create it |
| `capacityAvailable` | Compatibility boolean: whether the address holds or could obtain an activation lease under `maxAgents` |
| `capacity` | Current derived identity leases used/limit and separate run slots used/limit; not persisted |
| `holdsActivationLease` | Whether this exact address currently consumes identity capacity |
| `modelId`, `provider`, `effort`, `role`, `tools`, `instructions` | Effective profile (record if live, resolved config otherwise) |
| `writable` | Effective tools include a mutation tool |
| `canSpawn` | Whether the subagent may delegate response-required requests to other subagents, known or unknown |
| `state` | `new` for prospective addresses, otherwise the lifecycle state |
| `currentActivity` | Latest activity summary, when present |
| `queued` / `unanswered` / `outgoingUnanswered` / `pendingReplies` | Queued inbound, incoming open requests, requests sent by this identity that remain open, and replies reserved but not yet delivered |
| `archiveEligible` | Current derived result of the same active/queued/open-blocker rules used by `archive`; the action still revalidates and cleanup can still fail closed |
| `archiveBlockers` | Bounded counts and up to five real request/mail IDs per queued, incoming, outgoing, and pending-reply category; includes omitted counts and no subjects/bodies/counterparties |
| `usage` | Cumulative tokens, cost, context size, turns |
| `failure` | Last failure diagnostic, when present |
| `cleanup` | Optional persisted cleanup quarantine: pending/unknown state, worker generation, abort/dispose phases, unknown quiescence, exact `mutationCapableAtStart` and `heldRunSlot` facts, bounded active tool IDs/names, and non-sensitive detail |
| `providerReady` | `available` for a live worker, `unavailable` when an existing exact binding is absent, otherwise `unknown` |
| `lifecycle` | Exact persisted policy for an existing identity, or currently resolved configured defaults for a prospective one |

Failures throw `Could not inspect agent: <reason>`, so Pi records `isError: true` — typically an invalid address shape, invalid effort, an effort override supplied for an existing identity, or a prospective model ID that current provider preference cannot select uniquely. Existing unavailable identities remain inspectable instead of being resolved as new.

## Usage guidance

- Call before delegating when recipient capability is uncertain — in particular before authorizing repository changes, to confirm the address is actually writable.
- Also useful before spawning to distinguish identity lease use from run concurrency, check whether this address already holds a lease, and inspect exact bounded blockers.
- Follow the rendered recovery hint. Reuse a relevant leased identity first; restart real stopped/failed work; stop only to become inactive; cancel only a user-abandoned exact request after final validation; archive only when clean; then retry.
- When `cleanup` is present, do not interpret a detached worker or elapsed deadline as safety. Restart, archive, and clear-failure remain blocked; accepted mail is queued until affirmative quiescence is available.
- Live retry activity is Pi-managed and non-terminal; wait for settlement rather than restarting. After terminal failure, inspect Work and Conversation, correct configuration/provider availability as needed, and explicitly restart the same identity only when possible effects have been accounted for. Never resend the accepted envelope merely because a provider attempt failed.

See [Provider retry visibility and recovery](provider-retry-recovery.md) for event ordering, settings parity, attribution boundaries, and safe escalation artifacts.
