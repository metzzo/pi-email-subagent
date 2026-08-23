# Active-tool-aware idle watchdog implementation plan

## Status, priority, and classification

- **Status:** complete; focused red/green regressions and full release validation passed
- **Priority:** P1 reliability/correctness
- **Classification:** lifecycle watchdog semantics, concurrency/race safety, deterministic regression coverage
- **Target baseline inspected:** `bc6da78f901eefafb63dea4369b9d992eada3a76`
- **Primary ownership:** this extension (`src/sdk-worker.ts`, `src/broker.ts`); no Pi-core change is required for the smallest first release because Pi 0.81.1 already publishes tool-update events

This plan changes what “idle” means during an accepted run. It does **not** raise the 15-minute default as a substitute for correct liveness semantics.

## Implementation result

The implemented change adds a content-free `tool_lifecycle` worker event for Pi's start/update/end boundaries and a broker-local active-call map bound to the exact `WorkerTransport` and watchdog generation. Stable tool-call IDs make duplicate starts idempotent and orphan updates/ends harmless. Starts recorded before watchdog installation transfer only into the next generation for that exact worker. While one or more calls are active, the idle timer is absent; the final exact end arms a full new idle interval. Ordinary activity uses the same active-aware refresh path.

The absolute run timer is installed once and is never refreshed by tools, progress, work, activity, or steering. Timeout callbacks validate worker identity, watchdog generation, idle-arm generation, and timer state before synchronously claiming the terminal transition. Terminal, replacement, and shutdown paths clear ephemeral tool state. Progress updates return before worker snapshot synchronization, registry persistence, or UI publication. Timeout diagnostics contain only bounded generation/timing and tool ID/name counts, never tool arguments or output.

Focused tests include SDK translation/privacy, pre-watchdog starts, parallel last-end behavior, duplicate/orphan events, stale replaced workers, invalidated-idle and run-timeout/end races, progress publication/persistence suppression, ordinary idle expiry, and absolute run expiry. The real Pi 0.81.1 SDK-worker regression executes the built-in Bash tool with an output-silent Node child: the unchanged code failed at the shortened idle boundary, while the implementation lets that child finish and answer; a separate active Bash child still fails at the shorter absolute run deadline. The focused unit, integration, and E2E commands, full layer suites, `npm test`, package smoke, license policy, `npm run validate`, and the CI-pinned Gitleaks scan all pass. This validates the identified mechanism only. It does not attribute every historical idle alert to active tools and does not change cleanup/process-tree quiescence semantics.

## Evidence and confidence boundaries

### Confirmed audit evidence

The structured history audit supplied for this issue reports:

- 42 `LIFECYCLE_IDLE_TIMEOUT` alerts across 24 independent parent sessions.
- 27 alerts across 20 independent parent sessions correlate with a live Bash abort at the configured 900–3600 second idle boundary.
- Representative parent `01a020ac-0d64` contains worker session `2026-08-21T04-11-44-712Z_01a02284-82c8`, Bash call `c8fced40`, result `28dcd820` after about 1200 seconds, followed by main alert `88eb451a`.
- Representative parent `01a01825-bafb` contains worker session `2026-08-20T06-59-21-648Z_01a01df7-9bb0`, Bash call `352ab19c`, result `11dcba1f` after about 900 seconds, followed by main alert `24cd76e8`.

Those counts are already deduplicated by independent parent in the supplied structured audit. The raw history artifacts are not part of this repository checkout, so implementation tests must not pretend to reproduce or recount the historical population.

### Confirmed current-code evidence

- `src/config.ts` sets finite defaults of `runTimeoutMs: 14_400_000` and `idleTimeoutMs: 900_000` and validates all lifecycle delays against the Node timer maximum.
- `src/broker.ts`:
  - `startWatchdog()` starts one absolute run timer and one resettable idle timer after prompt acceptance;
  - `touchWatchdog()` resets only the idle timer;
  - `onWorkerEvent()` touches the watchdog for `activity` and `work` events;
  - `clearWatchdog()` and the watchdog generation prevent an old timer from expiring a later run.
- `src/sdk-worker.ts` handles `tool_execution_start` and `tool_execution_end`. Those boundaries generate `work` and/or `activity` events, but the switch has no `tool_execution_update` case and publishes no lifecycle-only signal while a tool remains in flight.
- The installed Pi dependency is `@earendil-works/pi-coding-agent` 0.81.1. Its built-in Bash implementation in `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js` publishes an initial partial update and throttled output updates, supports an optional finite per-call timeout, and aborts its local detached process group. `AgentSessionEvent` already includes `tool_execution_update`.
- `test/integration/lifecycle-policy.test.ts` proves that an ordinary fake activity event resets the idle timer and that the absolute run timer still expires. It does not represent an in-flight real Bash child.
- `test/unit/sdk-worker.test.ts` covers parallel tool-call correlation at start/end, but not update events or lifecycle liveness.
- `test/e2e/real-flow.test.ts` and `test/e2e/helpers/mock-provider-extension.ts` execute a real SDK worker and built-in Bash tool, but the current Bash scenario is `true` and cannot cross a shortened idle boundary.

### Inference to validate

The timing alignment and code path strongly support this mechanism: the broker interprets “no new worker event” as “no work,” even when Pi has an accepted tool call still executing. That can misclassify a healthy long tool as an idle stall. It is not proven that all 42 historical alerts share this cause, nor that every correlated Bash command was healthy. The new regression must validate the mechanism directly rather than treating correlation as proof for every alert.

## Problem and root mechanism

The idle watchdog observes event silence, not execution state. A tool start touches the timer once. A long Bash call may then do useful work without producing SDK-worker events until its result. If its duration crosses `idleTimeoutMs`, the broker expires the worker even though Pi still owns an in-flight tool execution.

Forwarding stdout updates alone is insufficient: commands commonly redirect test output to a durable file or remain intentionally silent. Conversely, exempting every active tool from every deadline would let a genuinely stuck tool run forever. The correct separation is:

1. **Idle deadline:** no model/tool work is known to be in flight and no activity arrives for `idleTimeoutMs`.
2. **Absolute run deadline:** the accepted run cannot exceed `runTimeoutMs`, regardless of model activity, output, or active tools.
3. **Tool-local bound:** Pi Bash’s explicit `timeout` remains an earlier tool-specific limit when supplied.

The existing finite `runTimeoutMs` is the separate hard bound for a tool that remains active or omits its own timeout. This first release must not add a new public lifecycle field without evidence that a generic cap shorter than the run deadline is required.

## Goals

1. Do not emit `LIFECYCLE_IDLE_TIMEOUT` while the current worker generation has one or more known in-flight tool calls.
2. Re-arm the idle deadline only after the last parallel tool call ends, using that boundary as fresh activity.
3. Forward `tool_execution_update` as a bounded liveness signal without copying stdout, stderr, commands, or partial results into broker state.
4. Preserve the absolute run timer exactly; active tools and tool progress never reset it.
5. Handle starts before watchdog installation, parallel calls ending out of order, duplicate/orphan events, worker replacement, and timer/end races deterministically.
6. Prove the behavior with a shortened-clock real SDK-worker Bash child rather than waiting 15 minutes.
7. Preserve current durable mail, reply obligations, work-ledger attribution, and UI behavior.

## Non-goals

- Raising `idleTimeoutMs` or making any lifecycle deadline infinite.
- Guaranteeing cleanup/process-tree quiescence after a timeout; that is a separate cleanup issue.
- Replacing Pi’s Bash timeout or adding an extension-owned command runner.
- Persisting live tool-call sets across process death. A process restart has no surviving SDK worker generation to resume.
- Treating output volume as proof of useful work or storing partial tool output in the registry.
- Adding `toolTimeoutMs` in the first release. Revisit only if measured requirements show that `runTimeoutMs` is too broad a cap for active tools.
- Changing work-ledger confidence or filesystem attribution.
- Broadening the fix to provider/model-stream liveness without separate evidence; this cluster is scoped to known in-flight tools.

## Required invariants

1. **Run deadline is absolute.** `tool_execution_start`, `tool_execution_update`, `activity`, `work`, and steering may affect idle liveness only; none moves the run deadline.
2. **Idle is armed only without active tools.** For a running watchdog generation, `activeToolCalls.size > 0` implies no idle timer is installed.
3. **Parallel calls are identity-based.** A `Set<toolCallId>` or equivalent map is used; never use a scalar counter that can underflow on duplicate/orphan ends.
4. **Last end restarts idle time.** Ending one of several calls does not arm idle. Ending the final call arms a full new `idleTimeoutMs` interval.
5. **Worker and run generation are authoritative.** An event from a detached/replaced worker cannot modify a current watchdog or active-tool set.
6. **Expiry claims once.** Once a watchdog generation is cleared/claimed for expiry, a same-tick tool end cannot revive it or change the recorded timeout code.
7. **Progress is content-free.** The broker receives tool ID/name/timestamp/phase only. It does not receive `partialResult`, output bytes, or arguments.
8. **Unknown events fail safe.** An orphan update/end is diagnostic-only and cannot clear another call. Duplicate start is idempotent for the same worker generation.
9. **Mailbox durability is unchanged.** An absolute run failure still leaves accepted requests open and queued mail recoverable under current journal semantics.
10. **No publication storm.** High-frequency Bash updates may touch an in-memory timestamp but must not persist the registry or publish a full UI snapshot for every chunk.

## Current code grounding

### Extension paths

- `src/types.ts` — `WorkerEvent`, `WorkerSnapshot`, and `WorkerTransport` contracts.
- `src/sdk-worker.ts` — `AgentSessionEvent` translation, work-ledger start/end handling, session generation, abort/dispose.
- `src/broker.ts` — watchdog installation, touch/clear/expiry, worker event filtering, scheduling, settlement, stop/restart/shutdown.
- `src/config.ts` — current finite run/idle defaults and validation; intentionally unchanged unless documentation wording requires no code change.
- `test/unit/sdk-worker.test.ts` — direct SDK-worker event translation tests.
- `test/integration/lifecycle-policy.test.ts` — broker watchdog semantics.
- `test/integration/lifecycle-races.test.ts` — worker replacement and stale-event races.
- `test/e2e/real-flow.test.ts` — real Pi RPC/broker/SDK-worker path.
- `test/e2e/helpers/mock-provider-extension.ts` — deterministic scripted worker tool calls.
- `test/e2e/helpers/rpc-client.ts` — canonical parsed main-session JSON event stream. Worker-session tool events are not forwarded onto that stream and must be read from the recorded worker session.
- `docs/lifecycle.md`, `docs/configuration.md`, `README.md`, and `CHANGELOG.md` — public semantics and release note.

### Existing Pi-core surface to reuse

- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts` — `AgentSessionEvent` includes core tool start/update/end events.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js` — output updates and optional Bash timeout already exist.

Do not patch `node_modules`. If the pinned dependency stops publishing update events in a future version, treat that as a compatibility failure; active start/end tracking still remains the primary correctness mechanism for silent tools.

## Smallest defensible design

### 1. Add an ephemeral tool-lifecycle event

Extend the worker/broker transport with a lifecycle-only event such as:

```ts
interface WorkerToolLifecycleEvent {
  type: "tool_lifecycle";
  phase: "start" | "progress" | "end";
  toolCallId: string;
  toolName: string;
  at: string;
}
```

This event is not an activity item and is not persisted. `SdkWorker.onSessionEvent()` emits:

- `start` for every tool before any classification-specific work event;
- `progress` for `tool_execution_update`, without forwarding `args` or `partialResult`;
- `end` once for `tool_execution_end`, even when the tool result is an error.

Keep the existing work-ledger and user-facing activity events. The new event has one job: lifecycle truth.

### 2. Track active calls outside the timer entry

Maintain a broker map keyed by canonical address and bound to the exact `WorkerTransport`, for example `{ worker, calls: Map<toolCallId, { toolName, startedAt, lastProgressAt }> }`.

It must exist independently of `watchdogs` because a very fast worker can emit a tool start immediately after prompt acceptance but before `startWatchdog()` installs timers. `startWatchdog()` consults the already-captured set:

- always install the absolute run timer;
- install the idle timer only when the set is empty.

Clear the set when the exact worker settles, fails, expires, is stopped, is replaced, or the broker shuts down. Do not let a stale unsubscribe callback clear a newer worker’s set.

### 3. Make idle arming active-tool-aware

Use one focused helper for all idle transitions:

```text
refreshIdle(address, watchdogGeneration, signalAt):
  reject stale generation/worker
  clear existing idle timer
  if active tool set is non-empty: leave idle unarmed
  else: arm idleTimeoutMs from now
```

Event handling:

- `start`: add/idempotently refresh the call, then `refreshIdle()` (which disarms idle).
- `progress`: update only the matching call’s `lastProgressAt`; leave idle unarmed. Rate-limit any UI notification; normally publish none.
- `end`: remove only the matching ID, then `refreshIdle()`; this arms idle only after the final parallel call.
- ordinary `activity`/`work`: retain current touch semantics, but route through the same helper so an active tool cannot accidentally re-arm idle.
- prompt acceptance: install run timer and call the same helper.

### 4. Keep the existing hard bounds

Do not touch the run timer after installation. A silent active Bash call that exceeds the run deadline still fails with `LIFECYCLE_RUN_TIMEOUT`. A Bash call with an explicit tool timeout remains bounded earlier by Pi. Document that callers should provide a Bash `timeout` when they need a tool-specific cap shorter than the run policy.

This is bounded behavior, not an idle loophole: the maximum active-tool duration is the remaining finite run duration, and a configured Bash timeout may be smaller.

### 5. Define race precedence

- Timer callbacks first re-check broker disposal, watchdog generation, worker identity, and whether the timer type is still armed.
- `expireWorker()` atomically clears/removes the watchdog before awaiting cleanup. Once claimed, later worker events are ignored by the existing worker-identity check.
- If the last tool end is processed before the idle callback claims the generation, it clears the old timer and arms a new full interval.
- If the idle callback already claimed the generation, the tool end cannot undo failure.
- The absolute run timer is unaffected by an end arriving at the same boundary; normal event-loop order determines which observation wins, but exactly one terminal transition is recorded.

No promise ordering should depend on wall-clock equality in tests. Tests explicitly release deferred boundaries on either side of the claim.

## Test-first implementation phases

### Phase 0 — Freeze the contract in failing tests

Add tests before production changes:

1. A worker tool start makes a running watchdog report no idle timer while retaining its run timer.
2. Two parallel calls start; the first end leaves idle unarmed; the second end arms a fresh idle deadline.
3. A progress event contains no partial output/arguments and produces no registry-persistence or full-snapshot storm.
4. A tool already active before watchdog installation is recognized.
5. A real, output-silent Bash child runs longer than a shortened idle deadline but shorter than the run deadline and completes successfully.
6. A real active Bash child that crosses the shorter absolute run deadline still fails with `LIFECYCLE_RUN_TIMEOUT`.

If the real output-silent reproducer already passes on the unmodified production code, stop and explain which assumed event ordering was wrong. Do not land a speculative state machine.

### Phase 1 — SDK-worker event translation

Likely files:

- `src/types.ts`
- `src/sdk-worker.ts`
- `test/unit/sdk-worker.test.ts`

Deliver:

- lifecycle-only start/progress/end event type;
- content-free update translation;
- duplicate/orphan-safe unit sequences;
- parallel/out-of-order event coverage;
- no changes to work attribution or stored activity contents.

### Phase 2 — Broker watchdog state machine

Likely files:

- `src/broker.ts`
- `test/integration/lifecycle-policy.test.ts`
- `test/integration/lifecycle-races.test.ts`
- `test/helpers/fakes.ts`

Deliver:

- worker-bound active-call map;
- one active-aware idle refresh helper;
- start-before-watchdog recovery;
- cleanup on every worker terminal/replacement path;
- generation-safe timeout/end arbitration;
- no progress-triggered persistence/publication flood.

Use deferred fake workers only for exact event-order races. The behavioral regression remains a real SDK-worker/Bash test.

### Phase 3 — Real shortened-clock regression

Likely files:

- `test/e2e/real-flow.test.ts` or a new focused `test/e2e/lifecycle-watchdog.test.ts`
- `test/e2e/helpers/mock-provider-extension.ts`
- `test/e2e/helpers/rpc-client.ts` only if a reusable structured-event helper is needed

Scenario:

1. Configure a worker with an idle deadline substantially shorter than the Bash duration and an absolute run deadline substantially longer than both.
2. Have the scripted provider invoke the real built-in Bash tool with an output-silent Node child and a finite test-level Bash timeout.
3. Use the parsed main-session RPC stream for the delegation/reply or alert boundary. Worker tool events are internal to `SdkWorker`, so obtain `sessionFile` from parsed `registry.json` and parse the recorded worker session branch (prefer `SessionManager`; otherwise parse its canonical JSON entries) to correlate the Bash call/result by tool-call ID.
4. Use a structured readiness/timestamp artifact from the child to prove its execution crossed the shortened idle interval, then assert the recorded Bash tool result succeeded and the worker replied/settled.
5. Parse `registry.json` and `mail.jsonl` as JSON/JSONL. Assert no recorded `LIFECYCLE_IDLE_TIMEOUT` for the worker and one durable answered transition for the request.
6. In a separate case, make `runTimeoutMs` shorter than the Bash duration and assert the structured registry failure is `LIFECYCLE_RUN_TIMEOUT`, not idle timeout.

Choose shortened intervals with clear ratios and CI headroom rather than sub-50 ms timers. The suite must complete in seconds, not minutes.

### Phase 4 — Documentation and release note

Likely files:

- `docs/lifecycle.md`
- `docs/configuration.md`
- `README.md`
- `CHANGELOG.md`

Document idle versus active-tool versus absolute-run semantics, parallel-tool handling, and the recommendation to set Bash’s per-call timeout when a tool-specific bound shorter than the run deadline is needed.

## Deterministic validation matrix

All test output must be captured on its first run to durable files, then inspected with bounded reads only on failure.

| Layer | Scenario | Canonical assertion |
|---|---|---|
| Unit | start/update/end translation | parsed `WorkerEvent[]` phases and IDs; serialized event excludes sentinel args/output |
| Unit | two starts, out-of-order ends | active ID set contains the exact remaining call |
| Integration | start before watchdog install | broker’s structured watchdog state has run timer and no idle timer |
| Integration | last parallel end | idle remains absent after first end and is newly armed after final end |
| Integration | orphan/duplicate events | no underflow, no unrelated call removal, one diagnostic at most |
| Integration | idle callback versus final end | one terminal outcome per explicitly controlled ordering |
| Integration | run timeout with active tool | parsed `AgentInspection.failure` contains `LIFECYCLE_RUN_TIMEOUT`; worker becomes failed |
| Integration | stale prior-worker event | current generation timers and active set unchanged |
| E2E real Pi/Bash | silent child outlives idle only | parsed child readiness crosses idle; worker session has a successful correlated Bash result; registry has no idle failure; request is answered |
| E2E real Pi/Bash | child outlives run | parsed child readiness and registry record a run timeout despite the active tool |
| Regression | ordinary no-tool stall | existing idle-timeout test still fails after resettable inactivity |
| Regression | work ledger | existing parallel correlation, privacy, and attribution assertions remain unchanged |

Never count event names with grep or report grep counts. Parse the main RPC JSON stream, worker session branch, registry JSON, mail JSONL, and child readiness object through their canonical schemas; correlate by tool-call/request ID and assert only ordering that exists within a single canonical stream.

Planned validation commands:

```bash
npm run check
npm run test:unit
npm run test:integration
npm run test:e2e
npm test
npm run test:package
npm run check:licenses
```

No command above was run while writing this plan.

## Acceptance and release gates

Implementation is releasable only when all of the following hold:

1. The unchanged-code real Bash reproducer fails for the expected idle timeout, then passes after the production change.
2. A silent in-flight tool cannot trigger idle timeout before the last active call ends.
3. A permanently active tool still triggers the unchanged finite absolute run timeout.
4. Multiple parallel calls, duplicate/orphan events, pre-watchdog starts, stale worker events, and timeout/end races have deterministic coverage.
5. Progress events contain no command/output payload and do not create persistence or UI-update storms.
6. Existing mail durability and work-ledger privacy/attribution tests pass.
7. `npm run check`, the focused suites, the full suite, package smoke, and license policy pass from preserved first-run logs.
8. Documentation no longer describes any active tool as ordinary idle silence.

A historical alert-rate decrease is rollout evidence, not a test gate and not proof that every old timeout shared this mechanism.

## Observability and diagnostics

- Keep the stable failure codes `LIFECYCLE_IDLE_TIMEOUT` and `LIFECYCLE_RUN_TIMEOUT`.
- Enrich lifecycle diagnostics with bounded, non-sensitive metadata: watchdog generation, elapsed run/idle milliseconds, active-tool count, bounded tool names/IDs, and last lifecycle-signal timestamp.
- Never include tool arguments, Bash commands, stdout/stderr, or partial results in failure alerts or registry state.
- For an idle expiry, `activeToolCount` must be zero by invariant. A nonzero count is an internal-consistency failure and should be reported distinctly rather than mislabeled as ordinary idle timeout.
- For a run expiry, include the active-tool count/names so operators can distinguish model silence from a long tool without exposing content.
- Publish lifecycle transitions, not every output update. In-memory `lastProgressAt` is sufficient unless a terminal diagnostic needs it.

## Compatibility and migration impact

- No mail journal or registry migration is required; active calls are process-local and generation-local.
- No lifecycle configuration field or default changes in the first release.
- Persisted `LifecyclePolicy`, initial delegation schema, and `recipientLifecycle` output remain compatible.
- `WorkerEvent`/`WorkerSnapshot` are internal TypeScript contracts, so repository fakes and tests must be updated together.
- Pi 0.81.1 already provides update events. The implementation must continue to work correctly when a tool emits start/end but no updates; updates improve diagnostics, not correctness.
- Documentation changes are semantic clarification. Existing users with shorter idle deadlines gain the intended behavior; absolute run behavior remains unchanged.

## Risks and races

- **Lost start before watchdog creation:** avoid by storing active calls independently of timer installation.
- **Parallel underflow:** avoid with IDs, never a count-only protocol.
- **Stale event after replacement:** bind call state to the exact `WorkerTransport` and watchdog generation.
- **End/timeout same tick:** claim/clear the generation synchronously before cleanup awaits.
- **High-volume stdout:** translate updates to content-free liveness and avoid publish/persist on each update.
- **Tool never ends:** finite run timeout still expires; Bash’s explicit timeout may expire earlier.
- **Very long legitimate tool exceeds run policy:** it still fails by design. The initial lifecycle policy must request an appropriate finite run deadline.
- **Core event regression:** start/end tracking remains sufficient for correctness; add a package/E2E assertion that current real Bash still emits expected boundaries.

## Rollout

1. Land the red/green focused tests and production change together.
2. Ship without a feature flag: this corrects the documented idle/run distinction and retains the existing hard run limit.
3. Inspect structured post-release alerts by stable code and active-tool metadata, deduplicated by parent and worker generation.
4. If output-silent active tools still produce idle alerts, treat that as a state-machine defect. If truly stuck tools occupy workers until the run deadline, evaluate a separately specified `toolTimeoutMs` using measured requirements rather than weakening this fix.
5. Do not delete historical alerts; retain them as before/after evidence.

## Rejected overengineering

- **Increase the 15-minute idle default:** delays false failures without fixing semantics.
- **Reset idle only on stdout:** fails for redirected or intentionally silent commands.
- **Poll process tables or session JSONL:** racy, platform-specific, and unnecessary because Pi publishes tool lifecycle events.
- **Persist active tool IDs:** stale after process death and creates migration/recovery ambiguity without a live worker.
- **Create an extension-owned Bash runner:** duplicates Pi’s timeout, output, truncation, cancellation, and process-group logic.
- **Add `toolTimeoutMs` immediately:** expands every config, schema, registry migration, documentation, and compatibility surface without evidence that the existing finite run cap plus Bash timeout is insufficient.
- **Let active tools reset the run timer:** converts the absolute safety bound into an unbounded loophole.
- **Publish every partial result:** leaks content and creates registry/UI write storms.
- **Use a scalar active-tool count:** duplicate/orphan events can corrupt it; call IDs already exist.
