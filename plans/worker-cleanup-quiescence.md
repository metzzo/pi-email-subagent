# Worker cleanup quiescence and ownership-safety implementation plan

## Status, priority, and classification

- **Status:** extension containment complete with focused and full validation passed; generic active-tool process quiescence remains blocked on a released Pi receipt
- **Priority:** P1 safety/reliability
- **Classification:** async lifecycle cleanup, process quiescence, capacity/namespace ownership, late-promise races
- **Target baseline inspected:** `5bbcce0c1f40f50c586b79a6a14c5eece3388560`
- **Ownership split:** broker containment belongs in this extension; an authoritative built-in tool/process quiescence receipt may require Pi-core support

The release criterion is not “the abort/dispose call returned before a timer.” It is “the old worker can no longer execute provider/tool callbacks or mutate the shared workspace/namespace before ownership is reused.”

## Implementation result and residual blocker

The extension containment layer is implemented. Every broker teardown route now joins one cleanup lease bound to the exact `WorkerTransport` and monotonically assigned worker generation. Starting cleanup synchronously removes routing and subscriptions but retains the address quarantine, activation lease, and any active/concurrency slot. Caller timeout marks bounded persisted `pending`/`unknown` cleanup phases without cancelling or forgetting the underlying Promise. Late verified fake-worker receipts release only their exact lease and can resume one requested replacement; late rejection stays quarantined. Restart, archive, clear-failure, exact-address restoration, high-priority steering, and new mutable scheduling fail closed while unknown, while accepted mail remains queued with its stable journal ID. Persisted `pending` state becomes sticky `unknown` after process restart. Shutdown and session handoff retain namespace ownership rather than starting a replacement over unknown cleanup.

`SdkWorker.cleanup()` is one reused Promise. It suppresses events and unsubscribes immediately, bounds SDK abort response, always invokes session disposal, and returns content-free provider/session/tool confidence. A clean SDK session with no known active tool can verify callback settlement. Any tool active at cleanup start remains `unknown` with `PI_TOOL_QUIESCENCE_RECEIPT_UNAVAILABLE`; arguments, commands, output, and environment never enter the report or registry.

The directly recorded representative Linux test uses the real Pi 0.81.1 SDK worker and built-in Bash to start one Node parent plus an ordinary same-process-group Node descendant. Structured readiness records the exact parent/child PIDs and a unique heartbeat. On stop, both exact PIDs become absent and the heartbeat stops; red and green cleanup use only those recorded PIDs. This verifies that one tested same-group topology terminates. It does not reproduce the historical surviving `worker.js` launch pattern, which is absent from this checkout, and it does not prove escaped descendants, other topologies, or other platforms.

The installed supported contract documents `AgentSession.abort()` as waiting for agent idle, while `dispose()` returns void; neither returns a tracked process-group absence receipt. `shell.js` performs a group `SIGKILL`, but its tracking/kill functions are not an awaited public quiescence capability. Therefore the full issue-cluster release gate remains blocked: no released Pi version consumed here can provide authoritative generic active-tool/process quiescence. No `node_modules` or external repository was patched, and the extension deliberately keeps active-tool cleanup quarantined rather than fabricating `verified` confidence.

Focused SDK/registry, ownership-race, persisted-recovery, namespace-lock, and real-process tests pass. The full unit, integration, E2E, aggregate, package-smoke, license, validation, worktree-secret, and configured Git-history secret scans also pass. The passing test matrix releases the extension containment layer; it does not remove the explicit Pi-core blocker above.

## Evidence and confidence boundaries

### Confirmed audit evidence

The supplied structured audit identifies compound abort-plus-dispose deadline failures in independent parents:

- parent `01a015b8`, main alert `72b04b8b`;
- parent `01a01892`, main alert `71224a20`;
- parent `01a020ac-10db`, main alert `e19f9bea`.

It also identifies native stop failures in independent parents `01a02624` and `01a027e0`.

One descendant-survival case was checked directly: a worktree `worker.js` PID remained alive after abort and was still alive after another 120 seconds. This is evidence for that one descendant only. It must not be generalized into “descendants survive every lifecycle timeout” or into a population rate.

The audit also confirms that abort and dispose defaults are 10 seconds but configurable. A longer default might reduce individual deadline reports, but it would not make late cleanup cancellable or prove descendant quiescence.

The raw audit artifacts and the exact launch command for the surviving `worker.js` are not in this repository checkout. The reproducer phase must recover that command/process relationship if available; otherwise it must label the new descendant test as representative rather than exact.

### Confirmed current extension behavior

- `src/broker.ts` defines `bounded()` as a `Promise.race` against a timer. Its `finally` attaches a rejection handler to the original promise, but timeout does not cancel that promise.
- `src/broker.ts::expireWorker()` unsubscribes and removes the worker from `workers`, deletes its concurrent-run entry from `active`, and marks it failed **before** bounded `abort()` and `dispose()` complete.
- `src/broker.ts::stop()` removes worker ownership in a `finally` after bounded abort, then awaits bounded dispose; it marks the record stopped and releases active scheduling even when cleanup reported an error.
- `src/broker.ts::restart()` removes the old live worker before bounded dispose and creates a replacement even when old disposal reports an error.
- `src/broker.ts::archive()` removes the worker and later frees the activation lease even when dispose reports an error.
- `src/broker.ts::disposeOwnedWorkers()` clears `workers`, unsubscribers, and `active` before awaiting disposal results.
- `src/broker.ts::close()` correctly treats the namespace lock as a safety lease: when a shutdown phase times out, it retains the lock rather than allowing a replacement broker to overlap known late mutations. That shutdown invariant should be reused, not weakened.
- `src/sdk-worker.ts::abort()` awaits `session.abort()` only while streaming, then marks stopped in `finally`.
- `src/sdk-worker.ts::dispose()` is idempotent at the promise level and always unsubscribes/calls `session.dispose()` even if abort rejects, but it has no process/child-group census and returns no structured quiescence result.
- `src/index.ts` awaits broker shutdown on `session_shutdown`, but the `session_start` replacement path swallows a prior broker shutdown failure before continuing initialization.
- `test/integration/lifecycle-policy.test.ts` covers hanging fake abort/dispose and the global shutdown namespace-lock retention case.
- `test/integration/lifecycle-races.test.ts` covers fake late start, rejecting abort, rejecting dispose, and restart/send serialization. It currently accepts replacement after a disposal error and does not assert quiescence ownership.
- `test/unit/sdk-worker.test.ts` proves `dispose()` unsubscribes and calls `session.dispose()` when abort rejects. It does not prove process exit.

### Confirmed current Pi 0.81.1 behavior

The pinned dependency’s built-in local Bash code in `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js`:

- launches a detached process group on non-Windows platforms;
- calls `killProcessTree(child.pid)` for abort and Bash timeout;
- waits for the direct child through `waitForChildProcess()`;
- tracks detached child PIDs for process-level termination signals.

`node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js` kills the negative process-group ID with `SIGKILL` on POSIX, with a direct-PID fallback, and uses `taskkill /F /T` on Windows. The public `AgentSession.abort()`/`dispose()` surface does not return a process-group quiescence receipt or an inventory of child groups checked.

### Inference to validate

The code proves an ownership race even without the historical process artifact: after a bounded wait loses, the underlying cleanup may still resolve, reject, emit callbacks, or leave external processes while broker capacity is already reusable. It is plausible that this race contributed to the audited failures and the one surviving descendant, but the exact escape mechanism for that descendant is unconfirmed. It could be missed abort propagation, cleanup that never reached the Bash tool, a process that escaped its group, or another mechanism. The real reproducer must decide which branch is true before a Pi-core patch is specified as fact.

## Problem and root mechanism

A cleanup deadline answers only: “did this promise settle within N milliseconds?” It does not answer:

- whether the underlying promise was cancelled;
- whether a late promise is still running;
- whether the SDK session has stopped dispatching callbacks;
- whether a built-in Bash child/process group is absent;
- whether descendants escaped that group;
- whether it is safe to start a replacement worker or release namespace/capacity ownership.

The broker currently conflates the bounded observation with cleanup completion and removes ownership early. The result is a split-brain window: the old worker may still exist while the broker admits a replacement or another scheduled run into the shared workspace.

The fix needs two layers:

1. **Extension containment:** one cleanup lease/state machine retains scheduling, activation, address, and namespace safety until an authoritative cleanup outcome is known; late completions are observed and generation-checked.
2. **Pi-core quiescence contract, if the real reproducer requires it:** `SdkWorker` needs an awaited result that proves the session and built-in process groups it owned are gone. The extension must not manufacture that proof from a resolved timeout wrapper or PID-name scan.

## Goals

1. Centralize every worker teardown path behind one idempotent cleanup lease.
2. Stop routing new messages to a worker immediately, while retaining its ownership/capacity reservations until quiescence is known.
3. Never create a replacement for the same address, archive/free its activation lease, or claim safe shutdown while cleanup is pending or unknown.
4. Block new mutation-capable scheduling in the namespace while a prior active tool may still mutate it; preserve already accepted mail durably in the queue.
5. Observe late abort/dispose settlement and apply it only to the exact old worker generation.
6. Preserve stable timeout codes and add explicit phase/quiescence diagnostics instead of silently calling an unsafe worker stopped.
7. Prove real descendant termination using the real SDK worker and built-in Bash implementation.
8. Determine from evidence whether the extension can establish quiescence with existing Pi APIs or must require a Pi-core capability.
9. Keep shutdown bounded for the caller; safety leases may remain held after the call reports failure.

## Non-goals

- Killing processes by executable name, command substring, worktree path, or broad same-user PID scans.
- Claiming that one verified surviving descendant represents every timeout.
- Guaranteeing containment of deliberately daemonized processes that escape an OS process group unless Pi-core explicitly adds a platform containment capability for them.
- Replacing Pi’s Bash implementation in this extension.
- Waiting forever inside `stop`, `restart`, timeout handling, or shutdown.
- Dropping or terminally failing accepted mail merely because its worker is quarantined.
- Releasing safety because an operator clears a display failure.
- Introducing containers, per-agent worktrees, a general job scheduler, or a new process supervisor as part of this focused repair.

## Required invariants

1. **One cleanup lease per worker object.** Abort, dispose, stop, timeout, restart, archive, initialization failure, and broker shutdown join the same idempotent operation.
2. **Routing detaches before cleanup; ownership does not.** No new prompt/steer reaches the old worker once cleanup starts, but its active/concurrency reservation, activation lease, and address quarantine remain until release is safe.
3. **Timeout is not cancellation.** A bounded caller may return/throw while the underlying cleanup remains registered and observed.
4. **No replacement under uncertainty.** `restart()` cannot create a new worker until the prior cleanup lease has an authoritative quiescent result.
5. **No archive under uncertainty.** `archive()` cannot free the activation lease while cleanup is pending/unknown.
6. **No new mutation scheduling under uncertainty.** Once cleanup of an active external-process-capable worker becomes unknown, `pump`, `schedule`, `resumeEnforcement`, and high-priority steering cannot start new mutation-capable work in that namespace. Mail remains queued. Already-running siblings are not mislabeled as newly safe; their state is surfaced explicitly.
7. **Namespace ownership is safety.** Broker shutdown or session replacement cannot release/forget the namespace lease while a cleanup lease is pending/unknown.
8. **Late settlement is generation-safe.** An old cleanup callback cannot delete, stop, or overwrite a newer worker/record generation.
9. **Only affirmative proof releases quarantine.** A rejected cleanup promise, elapsed deadline, missing core capability, or unverifiable descendant state remains `unknown`, not success.
10. **Durable mail survives.** Accepted requests/replies and response obligations retain their existing journal transitions and stable IDs.
11. **Failure is explicit and sticky.** `clearFailure()` cannot hide a cleanup quarantine; restart/archive remain blocked until quiescence is resolved.
12. **Cleanup diagnostics are bounded and non-sensitive.** Store phase, codes, timestamps, tool IDs/names, and confidence—not commands, stdout, environment, or arbitrary process arguments.

## Current code grounding and exact likely files

### Extension production files

- `src/broker.ts` — `bounded`, watchdog expiry, stop/restart/archive, capacity/activation leases, shutdown barriers and namespace release.
- `src/sdk-worker.ts` — SDK session abort/dispose, event unsubscribe, idempotence, active-tool snapshot.
- `src/types.ts` — worker cleanup report, optional persisted cleanup diagnostic, snapshot/inspection fields.
- `src/registry-store.ts` — backward-compatible parsing and bounds for optional cleanup diagnostics.
- `src/index.ts` — broker replacement/session shutdown error handling and namespace handoff.
- `src/main-tools.ts` — inspect/manage diagnostics and restart/archive error wording if cleanup is quarantined.
- `src/ui.ts` — only the smallest status display needed to distinguish failed cleanup/quarantine from ordinary stopped state.
- `src/config.ts` — existing abort/dispose/global shutdown deadlines; no default increase is planned.

### Extension tests and helpers

- `test/unit/sdk-worker.test.ts`
- `test/unit/registry-store.test.ts`
- `test/integration/lifecycle-policy.test.ts`
- `test/integration/lifecycle-races.test.ts`
- `test/integration/hardening.test.ts`
- `test/e2e/real-flow.test.ts` or a new `test/e2e/worker-cleanup.test.ts`
- `test/e2e/helpers/mock-provider-extension.ts`
- a new focused real-process helper such as `test/e2e/helpers/descendant-process.ts`
- `test/e2e/helpers/rpc-client.ts` only if reusable structured process/lifecycle predicates are needed

### Documentation/release files

- `docs/lifecycle.md`
- `docs/manage-agent.md`
- `docs/configuration.md`
- `docs/inspect-agent.md`
- `README.md`
- `CHANGELOG.md`

### Conditional Pi-core work

Do not edit installed `node_modules`. If the real reproducer shows that current `AgentSession` settlement cannot prove termination, open a coordinated Pi-core change in the upstream source equivalents:

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/tools/bash.ts`
- `packages/coding-agent/src/utils/shell.ts`
- `packages/coding-agent/src/utils/child-process.ts`
- their focused unit/integration tests in the Pi repository

The extension must then pin/require the first Pi version that exposes the capability or detect it explicitly and fail closed. It must not silently treat an older void-returning `dispose()` as verified process quiescence.

## Smallest defensible design

### 1. Introduce a broker-owned cleanup lease

Use one internal entry per old worker, keyed by address and bound to a monotonically increasing worker generation:

```ts
interface WorkerCleanupLease {
  address: string;
  worker: WorkerTransport;
  workerGeneration: number;
  reasonCode: string;
  startedAt: string;
  activeToolsAtStart: readonly { toolCallId: string; toolName: string }[];
  operation: Promise<WorkerCleanupReport>;
  callerDeadlineReached: boolean;
}
```

`workers` remains only the routing map. When cleanup begins:

1. clear the watchdog and unsubscribe from ordinary worker events;
2. remove the worker from the routing map so no prompt/steer is accepted;
3. install/join its cleanup lease **before** any await;
4. retain `active`/concurrency capacity, the activation lease, and a separate address quarantine;
5. set bounded `currentActivity`/failure details and persist the transition;
6. observe the underlying operation to terminal settlement even if the caller deadline wins.

A cleanup lease is not persisted as a Promise. A bounded summary of unknown cleanup is persisted so process restart cannot silently erase the safety condition.

### 2. Make worker cleanup return confidence, not just `void`

Define a structured result along these lines:

```ts
interface WorkerCleanupReport {
  sessionDisposed: boolean;
  providerQuiescent: boolean;
  tools: readonly {
    toolCallId: string;
    toolName: string;
    quiescence: "verified" | "not-applicable" | "unknown";
    detailCode?: string;
  }[];
  quiescence: "verified" | "unknown";
}
```

The exact shape should stay small. The key rule is that broker code releases safety only on `quiescence: "verified"`.

`SdkWorker` should expose one idempotent `cleanup()`/`dispose()` operation that:

- captures the live SDK session and active tool IDs once;
- aborts the session if needed;
- unsubscribes and prevents further worker events;
- disposes the session in `finally`;
- waits for/collects Pi-core tool quiescence evidence where supported;
- returns `unknown` or rejects when it cannot establish the required facts.

A best-effort abort error may remain diagnostic while a later authoritative disposal/quiescence receipt succeeds. Conversely, a synchronous `session.dispose()` call alone is not process proof.

### 3. Separate caller deadlines from underlying cleanup

Retain configurable `abortTimeoutMs` and `disposeTimeoutMs` as responsiveness deadlines, but do not abandon their underlying promises.

A focused cleanup coordinator should:

1. start abort and observe its real promise;
2. after the abort response deadline, record `LIFECYCLE_ABORT_TIMEOUT` and begin/continue authoritative dispose rather than declaring the worker gone;
3. race the dispose/quiescence operation against `disposeTimeoutMs` for the caller;
4. on timeout, persist `cleanup.quiescence: "unknown"`, notify main once, and leave the lease registered;
5. attach a late-success path that releases quarantine only with a verified report;
6. attach a late-failure path that updates bounded diagnostics but retains quarantine.

Do not run multiple unrelated dispose operations against the same worker. Every route joins the same promise.

### 4. Preserve capacity and scheduling safety

While a cleanup lease is pending/unknown:

- the address cannot be restarted or restored;
- archive cannot release its activation lease;
- the concurrent slot remains accounted for;
- new mail to the identity may be journaled and queued but is not delivered; `ensureWorker()` must check the quarantine before its current create/restore path so a failed record cannot spawn a replacement;
- high-priority mail cannot steer the detached worker;
- `pump()` does not admit new mutation-capable runs while namespace mutation quiescence is unknown;
- `inspect_agent` and `/agents` report cleanup quarantine and held capacity explicitly.

Existing sibling runs may already be active when quarantine starts. Do not claim they are isolated. Let them reach their existing terminal boundary, but do not schedule additional mutable work. A later isolation design is outside this repair.

If a verified late cleanup releases the last namespace quarantine, persist the transition, free only the reservations owned by that lease, and resume queued scheduling through the ordinary `pump()` path.

### 5. Persist only the safety-relevant summary

Add an optional, backward-compatible record field, for example:

```ts
interface CleanupDiagnostic {
  state: "pending" | "unknown";
  reasonCode: string;
  startedAt: string;
  updatedAt: string;
  abort: "pending" | "succeeded" | "failed" | "timed-out";
  dispose: "pending" | "succeeded" | "failed" | "timed-out";
  quiescence: "unknown";
  detail?: string;
}
```

Remove it only after authoritative quiescence. Old registries default to no cleanup quarantine. Parser limits timestamps/enums/detail length and rejects incoherent states.

On startup, normalize a persisted `pending` phase to `unknown` because its in-memory promise owner no longer exists. A persisted unknown cleanup must prevent automatic worker restoration, the `ensureWorker()` send path, and mutation scheduling for that namespace until Pi-core or an explicit safe recovery mechanism can prove the old process group absent. The quarantined identity continues to consume its activation lease. Do not infer safety merely because the prior broker PID died; the directly observed surviving descendant disproves that inference for at least one case.

### 6. Reuse shutdown’s namespace-lock principle

`src/broker.ts::close()` already withholds namespace-lock release when bounded shutdown cannot prove quiescence. Extend its definition of `quiescenceKnown` to include all cleanup leases and persisted unknown cleanup.

The `session_start` replacement path in `src/index.ts` must not swallow an unsafe old-broker shutdown and proceed as if handoff succeeded. Surface the failure and decline to initialize a replacement that could share the same workspace/namespace safety domain.

Process death remains a hard boundary: the current proper-lockfile lease eventually becomes stale. Because a child can outlive the broker, full automatic recovery after process death requires the Pi-core process-containment receipt or a documented fail-closed persisted quarantine. Do not claim the current 10-second stale-lock delay proves descendant exit.

### 7. Add Pi-core proof when the current contract cannot supply it

First run the real descendant reproducer against current Pi 0.81.1, then inspect the authoritative Pi contract/tests for what a resolved abort actually guarantees.

- A passing representative PID test is necessary but not, by itself, a generic quiescence receipt. Keep the entire fix in this extension only if Pi’s supported contract establishes that resolved abort/disposal means every tracked built-in tool has settled and its owned process group is absent, and the extension can check that capability explicitly.
- If the child survives, the SDK returns before group absence, or the supported contract is silent about group absence, Pi-core must add an awaited quiescence API. The smallest core change should reuse its existing detached process-group tracking and kill path, add a bounded “group absent” wait, and return structured confidence to `AgentSession`.
- If the exact historical child called `setsid`/otherwise escaped the original group, process-group verification alone is insufficient. Record that limit and scope platform containment separately rather than claiming a generic descendant guarantee.

Avoid PID-name scans. On POSIX, a test may use `process.kill(pid, 0)` only as an assertion for the exact PID created by the test, with PID-reuse caveats bounded by the short test lifetime. Production proof belongs inside the owner that created/tracked the child group.

## Test-first implementation phases

### Phase 0 — Reproduce and classify before designing Pi-core changes

Add a real deterministic scenario using the pinned Pi runtime, SDK worker, and built-in Bash:

1. The Bash command starts a Node parent which starts a Node descendant.
2. The helper writes structured readiness JSON containing the exact PIDs and continuously updates a unique heartbeat file.
3. Trigger `manage_agent stop` and, separately, a shortened lifecycle timeout.
4. Observe structured cleanup events/registry state.
5. Assert the exact test PIDs no longer exist and the heartbeat stops changing after cleanup reports verified.
6. In test `finally`, use the recorded exact PIDs/process group for emergency cleanup so a red test cannot leak processes.

Use the exact historical launch pattern if it can be recovered. Otherwise label this as a representative same-group descendant case and add a second case only when evidence identifies a different process topology.

This phase classifies the failure mechanism. Whether Pi-core work is required is decided by the reproducer **and** the supported abort/quiescence contract; one passing descendant sample cannot upgrade an undocumented void disposal into proof. Do not pre-write a core process supervisor based only on inference.

### Phase 1 — Failing broker ownership-race tests

Likely files:

- `test/integration/lifecycle-policy.test.ts`
- `test/integration/lifecycle-races.test.ts`
- `test/integration/hardening.test.ts`
- `test/helpers/fakes.ts`

Use a minimal deferred `WorkerTransport` only where exact promise timing cannot be produced reliably with a real process. Cover:

- abort and dispose miss their caller deadlines, but the underlying cleanup stays registered;
- capacity and active-slot ownership remain held;
- restart/archive/new mutable scheduling are blocked;
- accepted mail remains queued and fetchable from the journal;
- late verified cleanup releases exactly its own lease and resumes the queue;
- late rejection remains quarantined;
- a stale late success cannot remove a newer worker generation;
- shutdown includes cleanup leases and retains namespace ownership on unknown state;
- `clearFailure` cannot clear quarantine;
- a clean stop still reaches `stopped` and a clean archive still frees capacity.

### Phase 2 — Cleanup lease and persisted diagnostic

Likely files:

- `src/types.ts`
- `src/broker.ts`
- `src/registry-store.ts`
- `src/main-tools.ts`
- `src/ui.ts` only for a bounded quarantine label
- `test/unit/registry-store.test.ts`
- the Phase 1 integration tests

Deliver:

- one idempotent cleanup coordinator;
- routing detachment separated from ownership release;
- held active/activation/address/namespace safety;
- optional bounded persisted cleanup summary;
- restart/archive/clear-failure guards;
- late-settlement generation checks;
- global mutable-scheduling quarantine while process quiescence is unknown.

### Phase 3 — SDK-worker authoritative cleanup

Likely files:

- `src/types.ts`
- `src/sdk-worker.ts`
- `test/unit/sdk-worker.test.ts`

Deliver:

- one cleanup promise reused by abort/dispose callers;
- session unsubscribe/disposal guaranteed in `finally`;
- active-tool inventory captured without arguments/output;
- structured report distinguishing SDK settlement from tool/process verification;
- no worker events after cleanup begins;
- no claim of process verification when the installed Pi API cannot provide it.

### Phase 4 — Conditional Pi-core capability and dependency upgrade

Required if Phase 0 fails the quiescence assertion **or** current Pi lacks an explicit supported group-absence contract:

1. Add an awaited Pi-core termination/quiescence receipt using the existing child/group ownership code.
2. Add Pi-core tests for direct child, ordinary descendant, abort/timeout race, already-exited group, and repeated cleanup.
3. Upgrade this repository to the released Pi version/capability.
4. Add package smoke that fails closed if the required runtime capability is missing.

A source patch inside this repository or `node_modules` is not acceptable.

### Phase 5 — Real end-to-end and lifecycle handoff proof

Likely files:

- a new `test/e2e/worker-cleanup.test.ts`
- `test/e2e/helpers/descendant-process.ts`
- `test/e2e/helpers/mock-provider-extension.ts`
- `test/e2e/helpers/rpc-client.ts` if needed
- `src/index.ts`

Cover real stop, real run/idle expiry cleanup, late shutdown/session replacement, and namespace-lock retention. Parse RPC JSON events, registry JSON, mail JSONL, readiness JSON, and exact PID checks. Do not use grep counts over transcripts/logs.

### Phase 6 — Documentation and release note

Likely files:

- `docs/lifecycle.md`
- `docs/manage-agent.md`
- `docs/configuration.md`
- `docs/inspect-agent.md`
- `README.md`
- `CHANGELOG.md`

Document caller deadlines versus underlying cleanup, quarantine/capacity behavior, queued-mail preservation, core/version requirements, process-topology limits, and operator-visible recovery diagnostics.

## Deterministic validation matrix

All suite output must be captured to durable first-run log files. Inspect only bounded failing sections after a nonzero exit.

| Layer | Scenario | Canonical assertion |
|---|---|---|
| Unit | abort rejects, dispose finalizes | structured cleanup report/diagnostic distinguishes error from verified/unknown quiescence |
| Unit | repeated cleanup calls | same operation/report object; session dispose invoked once |
| Unit | cleanup begins during active tools | captured IDs/names only; no args/output; no later worker events |
| Unit | legacy registry | absent cleanup diagnostic parses as no quarantine |
| Unit | malformed diagnostic | parser rejects invalid enums/timestamps/oversized detail |
| Integration | deadline then late verified success | routing removed immediately; capacity held until exact late release |
| Integration | deadline then late rejection | quarantine, capacity, and scheduling block remain |
| Integration | restart race | no replacement before proof; exactly one replacement after proof |
| Integration | stale cleanup callback | newer worker/generation remains untouched |
| Integration | archive/clear failure | neither frees/hides unknown cleanup |
| Integration | durable mail | parsed journal retains queued/open envelopes and stable IDs |
| Integration | shutdown | parsed lock-owner file remains held when any cleanup is unknown |
| E2E real Pi/Bash | manual stop | exact parent/descendant PIDs absent; heartbeat stopped; structured state is stopped only after proof |
| E2E real Pi/Bash | lifecycle timeout | stable lifecycle failure retained; descendant absent before capacity release |
| E2E real Pi/Bash | caller deadline/late cleanup | alert occurs once; no new mutable run before verified late transition |
| E2E real process restart | persisted unknown cleanup | restoration fails closed rather than spawning over unknown descendant state |
| Regression | clean stop/restart/archive | existing successful lifecycle controls and mail obligations remain correct |
| Regression | broker shutdown | known-clean shutdown releases the namespace; unknown cleanup retains it |

Use a structured readiness object such as `{ parentPid, childPid, heartbeatPath, startedAt }`. PID existence checks apply only to these exact PIDs. Do not infer process counts from `ps`, grep, command names, or transcript text.

Planned repository validation commands after the focused red/green loop:

```bash
npm run check
npm run test:unit
npm run test:integration
npm run test:e2e
npm test
npm run test:package
npm run check:licenses
```

If Pi-core changes are required, also run its focused process/tool/session tests and full prescribed validation in the Pi repository, with preserved first-run artifacts.

No command above was run while writing this plan.

## Acceptance and release gates

### Extension containment gate

The extension portion is acceptable only when:

1. Every teardown path joins one cleanup lease.
2. Missing a caller deadline never releases routing replacement, active capacity, activation capacity, archive capacity, or namespace safety.
3. New mutable scheduling is blocked while process quiescence is unknown, while mail stays durably queued.
4. Late success/rejection is observed once and generation-safe.
5. Unknown cleanup is visible, sticky, and survives registry reload.
6. Known-clean stop/restart/archive behavior remains functional.

### Full issue-cluster release gate

Do not call the descendant/quiescence issue fixed until:

1. A real SDK-worker/Bash reproducer covers a parent plus descendant and passes exact-PID/heartbeat termination assertions.
2. The broker receives affirmative quiescence evidence before releasing ownership.
3. If existing Pi cannot provide that evidence, the required Pi-core capability is released, consumed, and checked by package smoke.
4. The exact historical survivor topology is either reproduced or explicitly left as an unverified topology limit; documentation makes no broader guarantee.
5. Structured diagnostics distinguish abort timeout, dispose timeout, SDK disposal, process verification, and retained quarantine.
6. Focused suites, full suite, package smoke, and license checks pass from preserved first-run logs.

A timeout-free test run alone is insufficient; the real descendant must be observed ready and then observed absent.

## Observability and diagnostics

- Preserve stable `LIFECYCLE_ABORT_TIMEOUT`, `LIFECYCLE_DISPOSE_TIMEOUT`, and broker shutdown timeout codes.
- Add a bounded structured cleanup diagnostic to inspection/snapshots: reason code, worker generation, start/update times, abort/dispose phase state, quiescence confidence, held-capacity flag, and active tool names/IDs.
- Keep the original lifecycle failure as the primary cause and append cleanup phase results without overwriting it.
- Emit one main alert when cleanup first becomes unknown and one state transition when it later becomes verified/releasable. Do not emit periodic progress alerts.
- `/agents` and `inspect_agent` should say plainly: cleanup unknown, restart/archive blocked, capacity held, queued mail preserved.
- Never expose Bash commands, process environment, stdout/stderr, or arbitrary child arguments.
- A “verified” label must name its source/capability internally; a mere resolved wrapper promise is not a source.

## Compatibility and migration impact

- Add the persisted cleanup summary as an optional field. Existing version-1 registries without it load as no quarantine; no journal rewrite is needed.
- Keep mail envelope and reply-transition schemas unchanged.
- Clean lifecycle operations retain existing tool commands and successful result shapes.
- Unsafe cleanup changes behavior intentionally: stop may remain failed/quarantined instead of being labeled stopped; restart/archive may reject until proof; sends remain accepted/queued rather than routed.
- If a new inspection field is public, make it optional for compatibility and document it.
- If Pi-core capability is required, set a real minimum supported package version or perform explicit feature detection. Older runtimes must fail closed with an actionable message rather than silently downgrade proof.
- Persisted unknown cleanup across process death may require operator intervention or a future verified recovery action. This availability cost is preferable to silently overlapping a surviving descendant.
- Cross-platform confidence may differ. A capability report must state whether POSIX process-group or Windows tree/job verification is supported; unsupported platforms remain unknown rather than guessed clean.

## Risks and race analysis

- **Permanent quarantine after a truly hung cleanup:** capacity may remain unavailable. This is an intentional fail-closed result; provide clear diagnosis, not automatic unsafe release.
- **Late success races a replacement:** replacement is prohibited before verified release; generation checks remain defense in depth.
- **Abort and dispose overlap:** centralize them in one coordinator and one authoritative operation; do not let every caller start another cleanup.
- **Promise settles after broker close:** the callback may update in-memory/persisted state only while its exact broker generation is valid; it must never release a newer namespace.
- **PID reuse:** production proof should come from Pi’s tracked handle/group, not later name/PID scanning. Test exact-PID checks occur over a short bounded interval and also use the unique heartbeat.
- **Escaped descendants:** ordinary process groups cannot prove absence of a process that deliberately creates a new session. Do not expand claims beyond tested/supported containment.
- **Existing sibling workers:** they may already overlap in the shared workspace when quarantine starts. Block new mutable admissions and disclose the limit; do not pretend retroactive isolation.
- **Shutdown budget consumption:** return within the global caller deadline, retain the namespace lock/quarantine, and keep observing the cleanup promise.
- **Registry write fails after cleanup state changes:** keep the in-memory safety lease and notify; never release merely to make persistence succeed.
- **Mail pressure while quarantined:** existing queue caps continue to bound storage; accepted mail remains durable.

## Rollout

1. Land the real failing reproducer and broker ownership-race tests first.
2. Land extension containment and explicit diagnostics even if Pi-core work is still pending; label the full cluster incomplete until the core gate is satisfied.
3. If needed, land/release Pi-core quiescence support, upgrade the dependency, and activate verified release via explicit capability detection.
4. Run a canary with shortened lifecycle scenarios and exact structured artifacts before broad release.
5. Monitor cleanup codes and quarantine transitions deduplicated by parent/worker generation. Do not report rates from grep over transcripts.
6. Keep a rollback path that disables new worker admission while retaining mail and namespace safety. Never roll back by releasing unknown cleanup.

## Rejected overengineering and unsafe shortcuts

- **Raise abort/dispose defaults:** changes latency but not cancellation or proof.
- **Treat `Promise.race` timeout as cancellation:** factually incorrect; the original promise remains live.
- **Release on any late promise settlement:** rejection or a void SDK dispose result may not prove process absence.
- **Kill every `node`, `worker.js`, or worktree-matching PID:** risks unrelated processes and relies on mutable names/paths.
- **Poll `ps`/grep in production:** platform-specific, racy, susceptible to PID reuse, and not ownership proof.
- **Build a second Bash runner in the extension:** duplicates Pi-core and still cannot safely own all tool processes.
- **Start a replacement “in case cleanup probably worked”:** recreates the unsafe overlap this plan removes.
- **Delete queued/open mail to free capacity:** violates durable obligations and hides the failure.
- **Let `clear_failure` clear quarantine:** changes display state, not reality.
- **Wait forever in user-facing lifecycle calls:** violates bounded responsiveness; retain safety asynchronously instead.
- **Adopt containers/cgroups/worktrees immediately:** potentially useful isolation milestones, but too broad for the confirmed deadline/ownership race and not uniformly available.
- **Claim all descendants are handled after one real test:** one representative proves only its tested process topology.
