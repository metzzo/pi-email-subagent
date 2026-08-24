# manage_agent

Control an existing agent's lifecycle without assigning work. Main-thread only. Sending email remains the only way to create agents or assign tasks. Execution mode: **sequential**.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `address` | string | ✓ | Existing subagent address |
| `action` | `"stop" \| "restart" \| "archive" \| "clear_failure"` | ✓ | Lifecycle action |

## Actions

### `stop`

Detaches routing immediately and joins the worker's one cleanup lease. State becomes `stopped` only after a structured verified cleanup report; the record, session file, mailbox, and activation lease are retained. If cleanup misses its caller deadline, rejects, or cannot prove process quiescence for a generation that ran Bash or still has an active tool, state is failed with a sticky cleanup quarantine instead. Identity capacity remains held, queued inbound mail stays queued, and later sends remain durable but do not run. **Stop makes an identity inactive; it does not free `maxAgents` capacity.** Errors when the address is unknown or the agent is `archived`.

### `restart`

Joins verified cleanup of any old worker before creating a fresh one bound to the same persisted exact provider/model, session file, and mailbox. Current main-provider preference is not consulted; restart rechecks extension-start API/long-cache metadata and supported non-secret credential-source equivalence. If the exact tuple or readiness contract is absent, restart fails with correction/reload guidance rather than substituting a same-ID model. No replacement is created while cleanup is pending or unknown. If cleanup verifies only after the caller-visible restart deadline, the record becomes paused/recoverable and no hidden replacement is created; a new explicit restart is always required. The replacement resumes enforcement for unanswered mail or scheduling for queued mail and clears `failure` and the reminder counter. Requires free capacity under `maxAgents` when the agent no longer holds an activation lease.

A live Pi-managed retry is not a reason to restart: Pi owns that automatic continuation. Before restarting a terminally failed worker, inspect `/agents` Work and Conversation. Current-batch edit/write/shell/custom attempts mean effects may exist; absence of a recorded item does not prove pre-tool safety. Restart is explicit same-identity recovery that preserves the existing session, provider binding, mailbox, lifecycle, effort, and stable accepted mail ID. It does not resend the envelope and does not promise that replaying later model decisions is side-effect-free. Never redelegate the same possible-effect scope while its original obligation remains open.

### `archive`

Frees the agent's activation lease (capacity) while keeping its record, session, and mail. Guard rails:

- Running, spawning, or streaming agents must be stopped and settled first. The error names the active category and reminds you that stop alone retains the lease.
- The agent must have no queued mail and no open obligations in either direction — no unanswered requests addressed to it, and no requests it sent that are still unanswered or have a reply pending delivery. Refusal reports bounded category counts, up to five real request/mail IDs per category, and omitted counts, without subjects, bodies, or counterparty addresses. Completed identities should answer all mail. If the user intentionally abandons a request to an inactive recipient, close that exact obligation first with [`cancel_request`](cancel-request.md); cancellation is audited and is not a fabricated answer.

The activation lease is released only after any live worker reports verified cleanup. Pending/unknown cleanup blocks archive and retains capacity. Already-archived agents are a no-op. Sending new mail to an archived address restores it (disposition `restored`) only through its persisted exact provider/model; a later main switch cannot rebind it. Archive clean completed identities instead of creating unlimited replacement addresses.

### `clear_failure`

Deletes the stored `failure` diagnostic. Only valid while the agent is `idle`, `stopped`, or `archived`, and never while cleanup is quarantined: clearing text cannot establish quiescence or release held capacity. A failure on a live obligation path must be resolved by `restart` or by answering the mail, not by clearing the message.

## Result

```text
stop completed for reviewer.audit@gpt-5.6-sol.com. State: stopped.
Identity lease remains held; stop alone does not free maxAgents identity capacity. Identity capacity: 8/8 activation leases used · run concurrency: 0/4 slots used.
```

Action-specific text reports that stop retains its lease, restart resumes the same persistent session/mail, archive released the lease, or clear-failure did not resolve obligations. `details` additively carries `address`, `action`, resulting `state`, current derived `capacity`, `holdsActivationLease`, and `archiveEligible`. Failures throw `Could not manage agent: <reason>`, so Pi records `isError: true` — unknown address, invalid transition, capacity limit, bounded actionable archival blockers, cleanup deadline, or unknown quiescence. Use [`inspect_agent`](inspect-agent.md) for the same capacity/blocker view and cleanup diagnostic.

## Safe identity-capacity recovery

1. Reuse a relevant existing identity when that is semantically appropriate.
2. Restart stopped/failed real assigned work instead of abandoning it.
3. Stop only to make active work inactive; the lease stays held.
4. Cancel only an exact request the user explicitly abandoned, after its recipient is inactive and final validation succeeds.
5. Archive only after queued mail and open obligations are clear.
6. Retry the new/restored identity after archive releases the lease.

No step is automatic or bulk. Capacity pressure alone authorizes neither cancellation nor archive. Provider failure also authorizes no automatic restart, resend, provider switch, or cancellation; follow [provider retry visibility and recovery](provider-retry-recovery.md). Removed or duplicate model bindings follow [provider-aware durable model routing](provider-aware-model-routing.md).

## Equivalents

The same actions are available interactively: `/agents stop|restart|archive|clear-failure <address>`, or the dashboard (`/agents`, keys `k` / `r` / `a` / `x`). Effort changes are a separate surface: `/agents effort <address> <level>` or the dashboard `m` key, valid only while the agent is idle. Abandoned obligations use the separate exact-ID command `/agents cancel <request-id> <reason>`.
