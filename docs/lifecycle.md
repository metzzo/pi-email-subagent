# Agent lifecycle deadlines

Every subagent has one finite lifecycle policy accepted at initial delegation and stored before worker/provider startup. Delays are positive integers no greater than Node's safe `setTimeout` maximum (`2147483647` ms). Initial mail also persists exact provider/model binding and effort, so crash recovery does not reselect them.

## Semantics

- `spawnTimeoutMs`: one caller deadline covering worker factory creation and `start`.
- `promptAcceptanceTimeoutMs`: bounds prompt preflight/acceptance and immediate steering delivery.
- `runTimeoutMs`: absolute maximum for each accepted run, including mailbox enforcement. Activity and tools do not extend it.
- `idleTimeoutMs`: active-run stall deadline only while no tool call is known active. Tool start disarms it; the last exact parallel tool end starts a fresh interval.
- `abortTimeoutMs` and `disposeTimeoutMs`: bound lifecycle callers waiting for the one cleanup operation. Expiry never cancels or settles that operation.
- `brokerShutdownTimeoutMs`: administrator-only global broker deadline.

Pi-managed retry/backoff remains within the accepted run and never resets its absolute deadline. Content-free model/tool start/end facts drive liveness; arguments, commands, progress, stdout, and stderr are not forwarded to the broker cleanup diagnostic.

## Cleanup contract

pi-subagent controls a trusted Pi 0.84.2 `AgentSession` and its currently active model/tool work. It is not an OS sandbox.

One exact worker-generation cleanup lease owns factory/start settlement, every already-started `AgentSession.prompt` preflight, `AgentSession.abort()`, active tool promises/listeners, and disposal. Routing detaches immediately. Cleanup invalidates prompt admission first, joins each preflight, and rejects late acceptance at Pi 0.84.2's synchronous `preflightResult(true)` boundary before `_runAgentPrompt` can start. If the session is streaming, cleanup waits for the real `abort()` result and Pi's idle boundary; it does not dispose at the abort caller deadline. Active tool IDs/names remain pending diagnostics until that boundary. Cleanup releases only when:

1. the exact factory/start operation settled;
2. every started prompt preflight settled or was vetoed;
3. streaming abort resolved successfully and the session reached idle (or the session was already idle);
4. active tool calls/listeners settled; and
5. session disposal succeeded.

The persisted compatibility field `quiescence` means only **Pi session/tool settlement**. It never claims that all OS descendants are absent. A completed ordinary Bash command such as `pwd`, `git status`, or a test suite is settled and does not permanently poison its worker generation.

Do not start background or detached processes unless the task explicitly requires them. When one is required, report how it is stopped. A process deliberately detached by a completed command may survive stop/restart/archive and is outside subagent stop semantics. The extension does not parse shell text, add containers/cgroups, or implement an OS process manager.

A caller timeout marks the exact address failed/quarantined while the same cleanup Promise remains observed. Replacement of that exact address is blocked, its queued mail is preserved, and a late successful settlement releases the lease. A rejection or final unknown report remains an exact-address failure. No cleanup at one address blocks prompt, steer, scheduling, or enforcement for unrelated mutable agents. Ordinary `maxAgents` and `maxConcurrent` limits still apply independently.

Restart never creates generation G+1 while generation G's factory/start/cleanup is genuinely pending. A caller-visible timed-out restart creates no hidden replacement; late settlement leaves the identity inactive and another explicit restart is required. Stop retains the identity lease. Archive releases it only after Pi session/tool cleanup settles and all mail/obligation blockers are clear.

## Dead namespace owner

The namespace lock is a cooperative per-parent state lease on one local host/PID namespace, not a workspace, distributed-filesystem, container, or security fence. Linux owner metadata includes namespace path, boot ID, PID, and `/proc/<pid>/stat` start time.

Acquisition serializes owner inspection, stale-lock removal, filesystem locking, and new-owner publication with an owner-transition guard. The caller namespace path must pass the same bounded/control-free predicate before any namespace, owner, lock, or transition artifact is created. Before any liveness comparison or removal, owner metadata requires that exact namespace, a canonical Linux boot-ID UUID, a positive canonical decimal start time, a positive safe PID, a nonempty bounded token, and a bounded canonical ISO timestamp. Generated metadata must round-trip through that validator, and release fails closed if its own exact owner is no longer recognizable. An exact live or `SIGSTOP`ed owner always rejects, regardless of lock mtime. When the complete exact recorded owner identity matches and that owner process is dead, startup automatically reclaims the stale proper-lockfile directory, acquires the namespace, and records `abandonedOwner: true`. Missing/incomplete/malformed identity, a lock without its sidecar, an owner-publication gap, a mismatched namespace, non-Linux exact-dead takeover, or an abandoned transition guard remains fail-closed without changing owner/lock bytes. On non-Linux hosts, an incomplete owner's PID may be reported as existing only to explain why a contender is blocked; PID existence does not establish exact-owner identity and never permits reclaim. An incomplete owner whose PID is absent or unknown remains unreclaimable.

The new owner keeps an abandoned-normalization obligation until the first registry commit containing every normalized record succeeds. An initialization failure before or reported at that commit does not release ownership as clean. The retained exact owner remains fail-closed until its process dies; the next exact-dead takeover repeats normalization before it can restore or prompt any worker.

After exact-owner death, that process's in-process `AgentSession` objects and callbacks are gone. Startup preserves registry records, mail, session paths, obligations, and provider/model bindings; clears coherent dead in-process run-slot/cleanup holds; marks formerly active identities `failed`; and requires explicit same-identity restart. It does not claim OS-process containment or auto-deliver queued work.

Legacy data is canonicalized on read:

- `verified-clean` becomes `session-settled`.
- A structurally valid `operator-released` plus its old exact audit becomes `failed`/`session-settled`; the audit/evidence field is removed and a bounded historical warning says no Pi-session or OS-process proof is claimed.
- After exact-owner death, the old generation-9-like shape (`abort` and `dispose` succeeded, no active tools, no held run slot, exact matching epoch) becomes `failed` with no cleanup diagnostic and the same bounded warning.
- A structurally ambiguous cleanup/epoch mismatch remains failed and blocked only at that exact address; no dead owner's run-slot claim or namespace-wide mutation quarantine is synthesized.

When startup reports an exact live owner, never delete its owner or lock artifacts. Close or resume that owning process first; after it exits, resume the same parent session and follow the checked-out version's documented recovery flow. A clone has a fresh mailbox and cannot recover obligations from the original parent session.

## Shutdown

Broker shutdown is bounded, but namespace ownership is released only after owned worker/session cleanup, in-flight broker operations, persistence, and mail flushes settle. If an owned cleanup remains genuinely pending or fails, shutdown reports the exact failure and retains the namespace lease. A later exact dead-owner startup can reclaim only after the recorded broker process is proven dead.

## Resolution

Lifecycle fields resolve independently:

1. initial `send_email.lifecycle` for an unknown recipient;
2. `addresses[canonicalAddress].lifecycle`;
3. `roles[name].lifecycle`;
4. global defaults.

Later mail cannot mutate a live, stopped, failed, or archived identity. Archived restoration preserves the original policy.

See [configuration.md](configuration.md), [send-email.md](send-email.md), [manage-agent.md](manage-agent.md), [inspect-agent.md](inspect-agent.md), and [provider retry visibility and recovery](provider-retry-recovery.md).
