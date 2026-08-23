# manage_agent

Control an existing agent's lifecycle without assigning work. Main-thread only. Sending email remains the only way to create agents or assign tasks. Execution mode: **sequential**.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `address` | string | ✓ | Existing subagent address |
| `action` | `"stop" \| "restart" \| "archive" \| "clear_failure"` | ✓ | Lifecycle action |

## Actions

### `stop`

Detaches routing immediately and joins the worker's one cleanup lease. State becomes `stopped` only after a structured verified cleanup report; the record, session file, and mailbox are retained. If cleanup misses its caller deadline, rejects, or cannot prove active-tool/process quiescence, state is failed with a sticky cleanup quarantine instead. Capacity remains held, queued inbound mail stays queued, and later sends remain durable but do not run. Errors when the address is unknown or the agent is `archived`.

### `restart`

Joins verified cleanup of any old worker before creating a fresh one bound to the same persistent session file and mailbox. No replacement is created while cleanup is pending or unknown. A cleanup that verifies after the caller deadline may complete the requested replacement generation-safely; otherwise an explicit later restart is required. The replacement resumes enforcement for unanswered mail or scheduling for queued mail and clears `failure` and the reminder counter. Requires free capacity under `maxAgents` when the agent no longer holds an activation lease.

### `archive`

Frees the agent's activation lease (capacity) while keeping its record, session, and mail. Guard rails:

- Running, spawning, or streaming agents must be stopped and settled first.
- The agent must have no queued mail and no open obligations in either direction — no unanswered requests addressed to it, and no requests it sent that are still unanswered or have a reply pending delivery. Completed identities should answer all mail. If the user intentionally abandons a request to an inactive recipient, close that exact obligation first with [`cancel_request`](cancel-request.md); cancellation is audited and is not a fabricated answer.

The activation lease is released only after any live worker reports verified cleanup. Pending/unknown cleanup blocks archive and retains capacity. Already-archived agents are a no-op. Sending new mail to an archived address restores it (disposition `restored`). Archive clean completed identities instead of creating unlimited replacement addresses.

### `clear_failure`

Deletes the stored `failure` diagnostic. Only valid while the agent is `idle`, `stopped`, or `archived`, and never while cleanup is quarantined: clearing text cannot establish quiescence or release held capacity. A failure on a live obligation path must be resolved by `restart` or by answering the mail, not by clearing the message.

## Result

```text
restart completed for reviewer.audit@gpt-5.6-sol.com. State: idle.
```

`details` carries `address`, `action`, and the resulting `state` (read back via inspection). Failures throw `Could not manage agent: <reason>`, so Pi records `isError: true` — unknown address, invalid transition, capacity limit, unmet archival preconditions, cleanup deadline, or unknown quiescence. Use [`inspect_agent`](inspect-agent.md) for the bounded cleanup phase diagnostic.

## Equivalents

The same actions are available interactively: `/agents stop|restart|archive|clear-failure <address>`, or the dashboard (`/agents`, keys `k` / `r` / `a` / `x`). Effort changes are a separate surface: `/agents effort <address> <level>` or the dashboard `m` key, valid only while the agent is idle. Abandoned obligations use the separate exact-ID command `/agents cancel <request-id> <reason>`.
