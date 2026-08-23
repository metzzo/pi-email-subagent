# Agent lifecycle deadlines

Every subagent has one finite lifecycle policy accepted at initial delegation and stored before worker/provider startup. Every delay must be an integer from 1 through `2147483647` milliseconds, the maximum Node can represent safely with `setTimeout`; larger values are rejected or ignored with validation rather than overflowing to an immediate timer. The policy is also copied into the durable first-mail spawn intent, so recovery from a crash between mail acceptance and registry persistence reconstructs the same values.

## Semantics

- `spawnTimeoutMs`: one absolute deadline covering worker factory creation and `start`.
- `promptAcceptanceTimeoutMs`: bounds prompt preflight/acceptance and immediate steering delivery.
- `runTimeoutMs`: absolute maximum for each accepted worker run, including mailbox-enforcement runs. Model activity, tool progress, and active tools never extend it.
- `idleTimeoutMs`: stall deadline during an active run when no tool call is known to be in flight. Worker activity resets it. A tool start disarms only the idle timer; after the last exact parallel tool-call ID ends, a fresh idle interval starts. A worker resting normally in the `idle` state has no active idle/stall timer.
- `abortTimeoutMs` and `disposeTimeoutMs`: independently bound cleanup.
- `brokerShutdownTimeoutMs`: global broker deadline. It is administrator-configured and rejected in an initial delegation override.

Run and idle timers start fresh after prompt acceptance and are removed on settlement, failure, stop, archive, restart, and shutdown. Tool calls that start immediately before watchdog installation are retained for that exact worker/run generation. Parallel calls are tracked by stable call ID, so duplicate or orphan boundaries cannot arm idle early. Tool progress is forwarded to the broker as content-free, in-memory liveness; arguments, commands, partial results, stdout, and stderr are not forwarded or persisted, and progress does not publish registry/UI snapshots.

Restart creates fresh timers. A timeout removes the live worker and concurrent-run lease, retains queued/open mail for diagnosis and recovery, and records a stable `LIFECYCLE_*_TIMEOUT` failure. Abort/dispose errors or timeouts are appended to that diagnostic. A known active tool remains bounded by the finite absolute run deadline. For Bash work that needs a smaller tool-specific bound, pass Bash's `timeout` argument; it can expire before `runTimeoutMs` without changing lifecycle policy.

Broker shutdown returns within the global bound even when cleanup hangs, but namespace ownership is released only after worker/session cleanup, in-flight mutation barriers, persistence, and flushes are known quiescent. If any of those operations times out and may still mutate state, shutdown fails promptly while deliberately retaining the namespace lease until process death; a replacement broker therefore cannot overlap late writes. `brokerShutdownTimeoutMs` is global administrator-only configuration and is not part of the six-field delegation schema.

## Resolution and mutation

Each field resolves independently:

1. Initial `send_email.lifecycle` for an unknown recipient.
2. `addresses[canonicalAddress].lifecycle`.
3. `roles[name].lifecycle`.
4. Global `lifecycle` defaults.

Every requested field must be a positive integer no greater than its `lifecycleMaxima` field. Later mail cannot mutate a live, stopped, failed, or archived identity. Archived restoration deliberately preserves the original policy; a future explicit management action would be required for safe mutation.

See [configuration.md](configuration.md), [send-email.md](send-email.md), and [inspect-agent.md](inspect-agent.md).
