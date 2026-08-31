# manage_agent

Control an existing agent's lifecycle without assigning work. Main-thread only. Sending email remains the only way to create agents or assign tasks. Execution mode: **sequential**.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `address` | string | ✓ | Exact existing subagent address |
| `action` | `"stop" \| "restart" \| "archive" \| "clear_failure"` | ✓ | Lifecycle action |

No cleanup-recovery action or evidence/generation fields exist.

## Actions

### `stop`

Detaches routing immediately and joins the exact worker-generation cleanup lease. Cleanup waits for factory/start settlement, the real Pi 0.84.2 `AgentSession.abort()` idle boundary when streaming, active tool promises/listeners, and disposal. State becomes `stopped` only after those Pi session/tool facts settle successfully. The record, session file, mailbox, and activation lease are retained, so stop does not free `maxAgents` capacity.

A caller timeout does not cancel cleanup. It leaves only that exact address failed/quarantined while the operation remains observed; queued mail stays durable and a late success releases the hold. Unrelated agents remain schedulable. A completed ordinary Bash command does not poison the generation.

### `restart`

Joins cleanup of the prior exact worker before creating a fresh generation bound to the same provider/model, session file, mailbox, effort, and lifecycle. No generation G+1 is created while G's factory/start/abort/tool/dispose operation is pending. A caller-visible timeout never creates a hidden late replacement; after late settlement, another explicit restart is required.

A live Pi-managed retry is not a reason to restart. Before restarting a terminal worker, inspect `/agents` Work and Conversation. Effects may exist even when the bounded ledger is empty. Possible-effect recovery uses the same identity/session/provider and never resends the accepted envelope or redelegates the same open scope.

### `archive`

Frees the activation lease while keeping the record, session, and mail. The identity must have no live worker, unsettled exact-address cleanup, queued mail, incoming unanswered request, or reply delivery pending. Refusal reports bounded blocker counts/IDs without mail bodies. Use [`cancel_request`](cancel-request.md) only for an explicitly abandoned exact obligation after its recipient is inactive.

A live worker is cleaned through the same Pi session/tool settlement boundary before archival. Already archived is a no-op. Sending mail to an archived address restores only its persisted exact provider/model binding.

### `clear_failure`

Deletes a stored failure only while `idle`, `stopped`, or `archived`. It cannot clear an unsettled cleanup diagnostic or resolve an obligation.

## Scope of cleanup

The cleanup boundary is the trusted Pi `AgentSession`, active model/tool work, listeners, and disposal—not arbitrary OS process trees. The compatibility field `quiescence` means only Pi session/tool settlement. Do not start background or detached processes unless the task explicitly requires one. If required, report how it is stopped. A process deliberately detached by a completed command is outside stop semantics because pi-subagent is not an OS sandbox.

If the exact prior broker owner dies, startup automatically reclaims its namespace only after Linux boot-ID/PID/start-time identity proves that exact process absent. It preserves mail/session/obligations, marks formerly active identities failed/inactive, and requires explicit same-identity restart. Live or `SIGSTOP`ed owners and incomplete/malformed ownership remain fail-closed. See [lifecycle.md](lifecycle.md).

## Result

```text
stop completed for reviewer.audit@gpt-5.6-sol.com. State: stopped.
Identity lease remains held; stop alone does not free maxAgents identity capacity. Identity capacity: 8/8 activation leases used · run concurrency: 0/4 slots used.
```

`details` contains `address`, `action`, resulting `state`, current derived `capacity`, `holdsActivationLease`, and `archiveEligible`. Failures throw `Could not manage agent: <reason>`, so Pi records `isError: true`.

## Safe identity-capacity recovery

1. Reuse a relevant existing identity only for continuing work in the same feature, worktree, or review-repair cycle, never for unrelated later phases or features.
2. Restart stopped/failed assigned work instead of abandoning it.
3. Stop only to make active work inactive; its identity lease remains held.
4. Cancel only an exact request the user explicitly abandoned, after its recipient is inactive.
5. Archive only after cleanup, queued mail, and open obligations settle.
6. Retry a new/restored identity after archive releases capacity.

No step is automatic or bulk. Provider failure authorizes no automatic restart, resend, provider switch, archive, or cancellation.

## Equivalents

The actions are available as `/agents stop|restart|archive|clear-failure <address>` or through the dashboard (`k` / `r` / `a` / `x`). Effort changes use `/agents effort <address> <level>` or `m`. Abandoned obligations use `/agents cancel <request-id> <reason>`.
