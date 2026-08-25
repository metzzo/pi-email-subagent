# manage_agent

Control an existing agent's lifecycle without assigning work. Main-thread only. Sending email remains the only way to create agents or assign tasks. Execution mode: **sequential**.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `address` | string | ✓ | Existing subagent address |
| `action` | `"stop" \| "restart" \| "archive" \| "clear_failure" \| "recover_cleanup"` | ✓ | Lifecycle or exact cleanup-recovery action |
| `workerGeneration` | positive integer | `recover_cleanup` only | Exact quarantined generation |
| `operatorEvidence` | string | `recover_cleanup` only | Human-supplied external-quiescence statement; 8–1,024 UTF-8 bytes before bounded redaction |

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

### `recover_cleanup`

This is a separate, explicit operator action; it is not an alias for `clear_failure`. The model may invoke it only after the human explicitly authorizes the exact address and `workerGeneration` and provides a substantive statement confirming external quiescence verification. Capacity pressure, elapsed time, abort/dispose success, a detached worker, or a dead namespace owner is never authorization.

The online broker accepts only an inactive `failed`/`paused` identity with a persisted `quiescence: unknown` cleanup whose state and abort/dispose phases are settled, whose durable worker epoch exactly matches the requested generation, and which has no attached/provisional worker, pending factory, pending cleanup operation, active tool, run slot, or concurrent lifecycle action. Success atomically persists `lastCleanupRecovery = { workerGeneration, releasedAt, evidence, source: "operator-attested" }`, changes that exact epoch phase to `operator-released`, removes only that exact quarantine/run hold, and leaves the identity failed or paused. It is not Pi-verified and does **not** use `verified-clean`; start a separate `restart` or `archive` action afterward. It never delivers queued mail, starts a provider retry, cancels an obligation, or pumps deferred work. An exact retry returns the existing audit; a conflicting generation or canonical evidence statement is rejected. A persistence failure rolls the in-memory record back, while a crash after atomic commit restores the new coherent operator-released state.

The evidence is bounded, terminal/control sanitized, and common credential forms are redacted before persistence. Broad prompt, dashboard, inspect, and management text displays only the audit source/generation/time, not the statement body. Do not put credentials in evidence; redaction is risk reduction, not a universal secret detector.

When broker startup is blocked by the orphan namespace lease, the `/agents` command remains registered:

```text
/agents recover-cleanup <exact-address> <worker-generation> --confirm <operator evidence>
```

The offline path is Linux-only and fail-closed. It acquires an exclusive recovery-operation guard; requires complete owner boot ID plus `/proc/<pid>/stat` start identity; rejects the exact live or `SIGSTOP`ed owner; rechecks owner, generation, cleanup, epoch, registry, and active facts; writes a restrictive unique backup; atomically rewrites `registry.json`; removes the exact orphan lock directory before its still-recorded owner sidecar; and prints the bounded `/reload` next step. Mail, sessions, other agents, and the durable recovery audit are preserved. Missing/malformed identity, non-Linux ownership, or any owner/registry race aborts without guessing. Owner absence proves only that the old namespace writer is absent; the human evidence, not process death, authorizes the release.

When startup reports a live namespace owner, do not attempt recovery until that owning process exits. Resume the same parent session and follow the checked-out version's documented recovery flow. A clone has a fresh mailbox and cannot recover obligations from the original parent session.

## Result

```text
stop completed for reviewer.audit@gpt-5.6-sol.com. State: stopped.
Identity lease remains held; stop alone does not free maxAgents identity capacity. Identity capacity: 8/8 activation leases used · run concurrency: 0/4 slots used.
```

Action-specific text reports that stop retains its lease, restart resumes the same persistent session/mail, archive released the lease, clear-failure did not resolve obligations, or cleanup was operator-released without a lifecycle action. `details` additively carries `address`, `action`, resulting `state`, current derived `capacity`, `holdsActivationLease`, `archiveEligible`, and for recovery only the non-evidence audit metadata (`workerGeneration`, `releasedAt`, `source`). Failures throw `Could not manage agent: <reason>`, so Pi records `isError: true` — unknown address, invalid transition, capacity limit, bounded actionable archival blockers, cleanup deadline, or unknown quiescence. Use [`inspect_agent`](inspect-agent.md) for the same capacity/blocker view and cleanup diagnostic.

## Safe identity-capacity recovery

1. Reuse a relevant existing identity when that is semantically appropriate.
2. Restart stopped/failed real assigned work instead of abandoning it.
3. Stop only to make active work inactive; the lease stays held.
4. Cancel only an exact request the user explicitly abandoned, after its recipient is inactive and final validation succeeds.
5. Archive only after queued mail and open obligations are clear.
6. Retry the new/restored identity after archive releases the lease.

No step is automatic or bulk. Capacity pressure alone authorizes neither cancellation, archive, nor cleanup recovery. Provider failure also authorizes no automatic restart, resend, provider switch, or cancellation; follow [provider retry visibility and recovery](provider-retry-recovery.md). Removed or duplicate model bindings follow [provider-aware durable model routing](provider-aware-model-routing.md).

## Equivalents

The ordinary actions are available interactively as `/agents stop|restart|archive|clear-failure <address>`, or through the dashboard (`/agents`, keys `k` / `r` / `a` / `x`). Exact cleanup recovery uses `/agents recover-cleanup <exact-address> <worker-generation> --confirm <operator evidence>` so it remains available when broker initialization failed. Effort changes are a separate surface: `/agents effort <address> <level>` or the dashboard `m` key, valid only while the agent is idle. Abandoned obligations use the separate exact-ID command `/agents cancel <request-id> <reason>`.
