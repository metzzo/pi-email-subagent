# inspect_agent

Preview or inspect an agent address without spawning it. Main-thread only. Execution mode: **parallel**.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `address` | string | ✓ | Subagent address to inspect or preview (existing or prospective) |

## Behavior

- Never spawns. For an unknown (but valid) address it computes the *effective* profile the agent would receive: model, provider, effort, role, tools, and instructions after exact-address → role → default resolution.
- Persisted identities whose model is no longer routable remain inspectable as failed/unavailable records; they do not prevent other agents from restoring or consume an activation lease.
- The address must parse and reference a routable model; otherwise the tool returns an error result (no side effects).
- `writable` is derived from the effective tools: `true` when they include any of `bash`, `edit`, `write`. Role labels alone grant nothing.

## Result

```text
Existing agent: reviewer.audit@gpt-5.6-sol.com
State: idle
Model: openai/gpt-5.6-sol · effort high
Role: reviewer · read-only · spawn disabled
Tools: read, grep, find, ls, send_email, fetch_emails
Capacity available: yes
Mailbox: 0 queued · 1 unanswered · 0 pending replies
Last failure: …            (only when present)
```

`details.inspection` (`AgentInspection`) fields:

| Field | Meaning |
|-------|---------|
| `exists` / `wouldSpawn` | Whether a record exists; whether a send would create it |
| `capacityAvailable` | Whether the address holds or could obtain an activation lease under `maxAgents` |
| `modelId`, `provider`, `effort`, `role`, `tools`, `instructions` | Effective profile (record if live, resolved config otherwise) |
| `writable` | Effective tools include a mutation tool |
| `canSpawn` | Whether the agent may create new identities by mailing unknown addresses |
| `state` | `new` for prospective addresses, otherwise the lifecycle state |
| `currentActivity` | Latest activity summary, when present |
| `queued` / `unanswered` / `pendingReplies` | Mailbox counts: queued inbound, open obligations to it, replies reserved but not yet delivered |
| `usage` | Cumulative tokens, cost, context size, turns |
| `failure` | Last failure diagnostic, when present |
| `providerReady` | `available` when a live worker exists, else `unknown` |

Failure text is `Could not inspect agent: <reason>` with `isError: true` — typically an invalid address shape or an unroutable/ambiguous model ID.

## Usage guidance

- Call before delegating when recipient capability is uncertain — in particular before authorizing repository changes, to confirm the address is actually writable.
- Also useful before spawning to check `capacityAvailable` when several agents are already active.
