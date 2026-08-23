# Agent lifecycle deadlines

Every subagent has one finite lifecycle policy accepted at initial delegation and stored before worker/provider startup. Every delay must be an integer from 1 through `2147483647` milliseconds, the maximum Node can represent safely with `setTimeout`; larger values are rejected or ignored with validation rather than overflowing to an immediate timer. The policy is copied into the durable first-mail spawn intent alongside exact provider/model binding and effort, so recovery from a crash between mail acceptance and registry persistence reconstructs the same values without selecting a provider again.

## Semantics

- `spawnTimeoutMs`: one absolute deadline covering worker factory creation and `start`.
- `promptAcceptanceTimeoutMs`: bounds prompt preflight/acceptance and immediate steering delivery.
- `runTimeoutMs`: absolute maximum for each accepted worker run, including mailbox-enforcement runs. Model activity, tool progress, and active tools never extend it.
- `idleTimeoutMs`: stall deadline during an active run when no tool call is known to be in flight. Worker activity resets it. A tool start disarms only the idle timer; after the last exact parallel tool-call ID ends, a fresh idle interval starts. A worker resting normally in the `idle` state has no active idle/stall timer.
- `abortTimeoutMs` and `disposeTimeoutMs`: caller-response deadlines inside one idempotent worker cleanup operation. Expiry records a timeout but does not cancel or forget the underlying cleanup.
- `brokerShutdownTimeoutMs`: global broker deadline. It is administrator-configured and rejected in an initial delegation override.

Run and idle timers start fresh after prompt acceptance and are removed on settlement, failure, stop, archive, restart, and shutdown. Pi-managed provider retry/backoff remains inside that one accepted run and does not reset the absolute deadline. Retry start/end is ordinary bounded activity and can refresh only the idle-stall observation; Pi alone owns its continuation. Tool calls that start immediately before watchdog installation are retained for that exact worker/run generation. Parallel calls are tracked by stable call ID, so duplicate or orphan boundaries cannot arm idle early. Tool progress is forwarded to the broker as content-free, in-memory liveness; arguments, commands, partial results, stdout, and stderr are not forwarded or persisted, and progress does not publish registry/UI snapshots.

Restart creates fresh timers while preserving the identity's exact persisted provider/model. A stopped or archived identity never follows a later main-provider preference; an absent exact tuple makes restart unavailable rather than substituting another provider. A timeout detaches the old worker from routing immediately and records the stable `LIFECYCLE_*_TIMEOUT` failure, but does not release ownership merely because a bounded wait ended. One cleanup lease owns abort, disposal, late settlement, and the exact worker generation. While cleanup is pending or unknown, its active/concurrency and activation capacity remain held, restart/archive/clear-failure are blocked, and newly accepted mail stays queued. An unknown cleanup for a writable worker also blocks new mutable scheduling in the shared namespace; already-running siblings are not retroactively isolated.

Only a structured `quiescence: verified` worker report releases an in-memory quarantine. Pi 0.81.1 documents `AgentSession.abort()` as waiting for session idle, but exposes no public built-in-tool/process-group absence receipt. This extension therefore reports an active tool at cleanup start as `unknown` even when SDK abort returns and session disposal succeeds. Clean SDK cleanup with no known active tool can verify session/provider callback settlement, but this is not a general descendant-containment guarantee. A directly recorded Linux E2E case verifies that one ordinary same-process-group Node parent and descendant launched by built-in Bash are both absent and its heartbeat stops after abort. Deliberately escaped sessions, other process topologies, other platforms, and the historical surviving `worker.js` topology remain unverified pending a released Pi quiescence capability.

Persisted cleanup state contains only bounded phases, confidence, tool IDs/names, and timestamps. A process restart converts `pending` to sticky `unknown` because the Promise owner was lost; it does not infer safety from broker death or the namespace lock's stale interval. A known active tool remains bounded by the finite absolute run deadline. For Bash work that needs a smaller tool-specific bound, pass Bash's `timeout` argument; it can expire before `runTimeoutMs` without changing lifecycle policy.

Broker shutdown returns within the global bound even when cleanup hangs, but namespace ownership is released only after worker/session cleanup, in-flight mutation barriers, persistence, flushes, and cleanup leases are known quiescent. If any operation times out, rejects without proof, or remains persisted unknown, shutdown fails promptly while deliberately retaining the namespace lease. Session replacement refuses to initialize a new broker after such a failed handoff. `brokerShutdownTimeoutMs` is global administrator-only configuration and is not part of the six-field delegation schema.

## Resolution and mutation

Each field resolves independently:

1. Initial `send_email.lifecycle` for an unknown recipient.
2. `addresses[canonicalAddress].lifecycle`.
3. `roles[name].lifecycle`.
4. Global `lifecycle` defaults.

Every requested field must be a positive integer no greater than its `lifecycleMaxima` field. Later mail cannot mutate a live, stopped, failed, or archived identity. Archived restoration deliberately preserves the original policy; a future explicit management action would be required for safe mutation.

See [configuration.md](configuration.md), [send-email.md](send-email.md), [inspect-agent.md](inspect-agent.md), [provider-aware durable model routing](provider-aware-model-routing.md), and [provider retry visibility and recovery](provider-retry-recovery.md).
