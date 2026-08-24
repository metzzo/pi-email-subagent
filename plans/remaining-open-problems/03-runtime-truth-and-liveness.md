# Cluster 3 — Run Liveness, Capability Truth, and Effect Evidence

Status: proposed — implementation not started
Revalidated at: `f32aa1efeb2991cd591cf70f497c7d510d46af01`
Priority: P1/P2
Depends on: Cluster 2 worker-local settings for reliable real Pi tests
Blocks: short idle policies, trustworthy capability inspection, safe restart guidance

## Cluster objective

Make broker decisions from content-free live runtime facts: whether model/retry/tool work is in flight, which tools Pi actually activated, whether a mutation may have happened, and whether disposal was attempted. Keep those facts ephemeral unless they are needed for conservative crash recovery.

## Issue inventory

| ID | Problem | Broken invariant | Priority |
|---|---|---|---|
| LIVE-1 | Model streaming and Pi retry backoff can expire as idle | known work must not be classified as stall | P2 |
| LIVE-2 | Broker retains configured rather than activated tools | capability claims must reflect runtime | P1 when used for authorization/recovery |
| LIVE-3 | Orphan mutations and unverified shell/custom evidence are incomplete across live/recovery paths | unknown effect must not look safe to replay | P1 |
| LIVE-4 | Never-settling abort prevents `dispose()` attempt | bounded cleanup must still progress conservatively | P2 |

---

## LIVE-1 — Model-stream and retry-backoff liveness

### Evidence in the current mechanism

The broker starts the watchdog after prompt acceptance. It refreshes idle on:

- activity events;
- work events;
- exact tool start/end lifecycle.

`SdkWorker.onSessionEvent()` currently ignores `message_update` and creates no content-free model lifecycle event. During a long model response:

- `agent_start` creates one activity;
- no further activity appears until final message/tool/retry event;
- idle can expire despite token or thinking deltas.

During Pi retry:

- `auto_retry_start` creates one activity;
- a backoff longer than `idleTimeoutMs` has no heartbeat;
- the broker can expire the worker before Pi performs the next attempt.

The absolute `runTimeoutMs` must still terminate both cases.

### Required state model

Add one ephemeral worker event family, separate from Activity and Work:

```text
run_liveness:
  phase = model_start | model_progress | model_end |
          retry_start | retry_end
  no message text
  no thinking text
  no provider error
  no token counts
  no request payload
```

The broker tracks, per exact worker/watchdog generation:

- model attempt phase for stale-boundary rejection and diagnostics, but not as an unconditional idle hold;
- finite Pi retry-backoff hold;
- active tool-call map already present;
- last content-free model-progress pulse timestamp.

### Pulse-versus-hold idle policy

- Model start, model delta/progress, and model end are **pulses**. Each arms or refreshes idle; model start must not disarm idle indefinitely.
- Therefore a model request that starts and then emits no delta/end still reaches `LIFECYCLE_IDLE_TIMEOUT`.
- Exact active tools are **holds** because Pi has emitted an exact start ID and no end ID.
- A Pi retry backoff is a **bounded hold** only when `auto_retry_start` supplies the known finite `delayMs`/attempt lifecycle. Set a hold deadline at `delayMs` plus scheduling slack measured by the deterministic characterization.
- Clear the retry hold on the next exact retry/attempt boundary, `auto_retry_end`, abort, settlement, or generation replacement. If no boundary arrives by the hold deadline, clear it and arm idle; a missing retry-end/next-attempt cannot suppress idle until the absolute run timeout.
- A valid retry hold can outlast the ordinary idle interval but never the absolute run deadline.
- Model progress handling must be coalesced so token-frequency updates do not cause timer, persistence, or UI storms.
- `runTimeoutMs` is created once per accepted run and never moved.
- When the last hold clears, arm idle from that transition; later model pulses refresh it.
- A stale worker/generation event is ignored.

### Pi event mapping to characterize

Use real Pi events rather than assuming order:

- `agent_start` and `agent_end` around one low-level attempt;
- `message_start/update/end` within an attempt;
- `auto_retry_start/end` between attempts;
- `agent_settled` after no retry/continuation remains;
- abort during model stream and during retry delay.

Existing retry characterization tests already parse event order. Extend them with watchdog state rather than creating a fake retry scheduler.

### Coalescing rule

Do not persist or publish liveness progress. A simple broker-side monotonic threshold is enough:

- always process phase boundaries;
- process progress only when it meaningfully advances the idle deadline;
- derive the coalescing interval from `idleTimeoutMs` with a safe upper bound;
- never use a hash of content or store content to deduplicate.

### Red tests

- spaced text deltas continue beyond a shortened idle interval;
- thinking-only deltas continue beyond idle;
- a model request emits start but no progress and stalls: idle fires;
- retry delay longer than idle reaches the next attempt;
- `auto_retry_start` with no retry end/next attempt loses its hold at the bounded deadline and later expires idle;
- abort during retry clears retry liveness;
- model/retry activity longer than run triggers run timeout, not idle;
- a replacement worker ignores stale progress/end events;
- no liveness event changes registry activity or writes session content.

### Done when

- idle reflects absence of known progress, not absence of visible final output;
- run remains absolute in all branches;
- real Pi event tests cover at least one stream and one retry sequence.

---

## LIVE-2 — Configured intent versus activated tools

### Evidence in the current mechanism

`SdkWorker.start()`:

1. copies configured `record.tools` to `requestedTools`;
2. passes the list to `createAgentSession()`;
3. replaces the worker's cloned `record.tools` with `session.getActiveToolNames()`;
4. reports unknown omitted tools.

`AgentBroker.syncWorker()` copies effort, usage, activity, work, and session file, but not `snapshot.record.tools`. The broker record therefore remains configured intent.

Consequences:

- `inspect_agent`, send results, and UI can advertise a tool Pi omitted;
- `writable` can reflect configuration rather than the live worker;
- cleanup/quarantine capability may use a stale set;
- prompt capability summaries describe profiles, not actual runtime activation.

### Data ownership

Keep two concepts explicit:

- **configured tools:** requested capability from role/address configuration;
- **activated tools:** exact names returned by the live Pi session.

Do not overload one field across both phases without clear migration semantics.

### Durable/live capability schema

#### Selected explicit schema

Keep `AgentRecord.tools` as current configured intent for backward compatibility, and add one bounded durable worker capability epoch:

```text
workerEpoch:
  generation
  phase = spawning | activated | verified-clean
  tools
  mutationCapable
  runSlotHeld
```

Transition order:

1. Before worker factory/start, increment and persist `phase: spawning` with configured tools and conservative mutation capability.
2. After `session.getActiveToolNames()` succeeds, replace epoch tools/capability with the activated set and persist `phase: activated` **before any prompt can be admitted**.
3. Before prompt admission, persist `runSlotHeld: true`; settlement or verified cleanup persists false.
4. Verified cleanup persists `phase: verified-clean` atomically with cleanup/capacity release.
5. Live inspection/send/UI expose `activeTools` only while the exact worker exists, deriving them from its snapshot; a persisted epoch is historical evidence, not a claim that tools are currently callable.

For a legacy record without `workerEpoch`, snapshot the raw loaded `record.tools` before applying the current profile. On abandoned-owner recovery, use that raw set as conservative prior-generation evidence. Never synthesize legacy capability from the new profile.

Do not merely overwrite `record.tools` with the active set. That loses the configured/live distinction and can erase historical mutation capability when configuration changes.

### Mutation classification rule

- During `spawning`, configured intent is the only fact; classify conservatively.
- Once `activated` is durably recorded before prompt admission, derive generation mutation capability from activated tools plus any actually observed process/tool risk. A configured `bash`/`write` that Pi omitted cannot execute in that activated generation and does not remain sticky merely because it was requested.
- Cleanup diagnostic captures `mutationCapableAtStart` from that exact epoch and never recomputes it from later config.
- Legacy/pre-activation records without an activated epoch remain conservative.
- Missing unknown tools do not grant live authorization; actually observed mutation/process risk is never erased by later configuration.

### Red tests

- configured `write` omitted by Pi;
- configured read-only worker receives only mail custom tools plus read tools;
- unknown custom tool omitted and surfaced once with bounds;
- inspect prospective versus live labels;
- send result uses activated tools for live recipient;
- configuration removes `bash` after a prior process-capable generation;
- cleanup diagnostic retains generation risk;
- registry migration from records without `workerEpoch` and inspection output without live `activeTools`;
- raw legacy tools captured before profile overlay;
- configured writable tool omitted at activation does not make the activated epoch writable;
- capability epoch is durable before first prompt admission.

### Done when

- every public live capability claim uses actual activation;
- every safety decision remains conservative across config and restart;
- role names never stand in for tools.

---

## LIVE-3 — Unknown-effect mutation and unverified shell/custom evidence

### Evidence in the current mechanism

At runtime, `SdkWorker` handles a `tool_execution_end` with no active start by calling `startWorkItem(..., args=undefined)`. For `edit`/`write`, the item has explicit attribution but no path. `finishWorkItem()` converts a successful result without a path to `failed`.

During session recovery, `recoverMutationWork()` ignores an `edit`/`write` tool result when:

- no matching tool call exists;
- tool names mismatch; or
- the reconstructed call has no safe path.

A successful result can therefore be labeled failed or disappear. Both outcomes can imply that replay is safe when the effect is actually unknown.

### Target representation

Add an explicit terminal unknown-effect state and bounded structural fields:

```text
status: unknown
attribution: unverified
observedResult: success | error
reasonCode: missing-start | mismatched-tool | unsafe-path | orphan-result
```

`observedResult` describes Pi's terminal tool-result flag only; it does not upgrade the effect status.

The bounded item contains only:

- safe tool-call ID;
- safe tool name;
- batch/timestamps when known;
- observed terminal result state (`success` or `error`) without claiming the mutation itself succeeded/failed;
- fixed reason code;
- no path if it cannot be trusted;
- no mutation body, provider payload, or raw tool result.

### Shell/custom evidence boundary

Shell and arbitrary custom tools remain `attribution: unverified` even when Pi reports a successful tool result. A successful terminal event proves only that Pi observed a non-error result; it does not prove which external/file effects occurred.

Session recovery should retain bounded structural shell/custom evidence when exact tool-call/result IDs remain in the active branch:

- tool-call ID and safe tool name;
- batch/timestamps when known;
- terminal success/error observation;
- unverified attribution;
- no inference of target files from free-form output;
- no promotion into confirmed mutation aggregates.

If compaction or bounded recovery omits the source entries, say evidence is unavailable; do not infer “no work.” Custom tools are conservatively possible-effect work because the extension cannot know their implementation from the name.

### Aggregation and guidance

- Unknown items never enter confirmed file/write/line aggregates.
- Unverified shell/custom items never enter confirmed file aggregates.
- `currentBatchHasEffectfulWork()` treats unknown mutation and unverified shell/custom items as possible effects.
- Work UI and terminal recovery say “effect unknown/unverified,” not confirmed.
- Restart/redelegation guidance treats unknown/unverified effect evidence as unsafe to replay automatically.
- Session recovery and live event handling produce the same classification for the same structural evidence.

### Migration

Adding `WorkStatus = "unknown"` requires:

- registry parser/schema updates;
- UI rendering;
- lightweight snapshot behavior;
- existing record migration/compatibility tests;
- aggregate and current-batch helpers;
- bounded reason codes rather than arbitrary detail.

Do not rewrite historical `failed` items heuristically. Only new/recovered evidence with a structurally unknown outcome uses the state.

### Red tests

- orphan successful `edit` end;
- orphan successful `write` end;
- orphan error end;
- start/end tool-name mismatch;
- unsafe/missing path with successful result;
- session tool result without assistant tool call;
- result outside the recovery slice bound;
- unknown item survives registry round trip;
- shell and custom success remain unverified;
- shell/custom exact-ID evidence recovers from the active session branch without parsing result prose;
- compacted/missing shell/custom entries do not become a no-effect claim;
- confirmed aggregates exclude unknown/unverified items, possible-effect guidance includes them.

### Done when

- no structurally unknown mutation is presented as definitely failed or absent;
- no raw mutation content leaks into work evidence;
- live and recovered views agree.

---

## LIVE-4 — Disposal progression after a hung abort

### Evidence in the current mechanism

`SdkWorker.cleanup()` owns one idempotent promise. When the session is streaming it currently:

1. awaits `session.abort()` with no internal deadline;
2. calls `session.dispose()` only after abort settles;
3. reports cleanup.

The broker has a caller deadline and persists quarantine when it expires, but the underlying cleanup operation remains pending. If Pi's abort never settles, disposal is never attempted.

### Target behavior

Use `WorkerCleanupOptions.abortTimeoutMs` inside the authoritative cleanup operation:

1. start/observe `session.abort()` once;
2. when abort settles early, call `dispose()` once;
3. when the abort response deadline expires, call `dispose()` once even though the abort promise remains observed;
4. never treat the deadline as cancellation;
5. if abort later settles, finish the cleanup report using the actual abort outcome;
6. if abort never settles, the authoritative promise can remain pending and broker quarantine remains sticky;
7. disposal success alone never proves provider/tool/process quiescence.

The broker's total wait still bounds caller responsiveness. The worker deadline only ensures disposal is attempted.

### Race requirements

- one abort invocation;
- one dispose invocation;
- no unhandled late rejection;
- unsubscribe and event suppression happen before either operation;
- repeated `cleanup()`/`dispose()` joins the same promise;
- dispose throw is recorded without discarding a later abort result;
- active/completed Bash risk remains unknown regardless of disposal.

### Red tests

- abort never settles, dispose called at deadline once;
- abort settles just before deadline;
- abort settles just after disposal;
- abort rejects before and after deadline;
- dispose throws;
- repeated cleanup callers;
- broker shutdown and manual stop share the operation;
- no stale session event mutates the record.

### Done when

- disposal is attempted within its specified progression even under hung abort;
- no branch upgrades unknown quiescence from disposal alone;
- late settlement evidence remains observable.

## Compatibility prerequisite for this cluster

If the implementation begins using a Pi event or session method not already guarded/tested, add its supported structural probe before the runtime path is enabled. Event ordering and pulse/hold semantics belong to the exact-version characterization tests, not feature detection.

## Cluster work packages

1. **LIVE-1a:** extend real Pi event characterization for stream/retry lifecycle.
2. **LIVE-1b:** add content-free pulse/hold liveness events and broker generation state.
3. **LIVE-2 + CRASH-1 joint package:** persist the capability epoch, synchronize configured/live tools, capture legacy tools before overlay, and change abandoned-owner classification in the same commit.
4. **LIVE-3:** add unknown-effect work state and consistent recovery.
5. **LIVE-4:** add abort-deadline disposal progression and race tests.

LIVE-2 should land before Cluster 4 so abandoned-owner mutation classification consumes the corrected capability contract.

## Cluster validation

Focused files:

- `test/unit/sdk-worker.test.ts`
- `test/unit/work-ledger.test.ts`
- `test/unit/registry-store.test.ts`
- `test/unit/ui.test.ts`
- `test/integration/sdk-worker-start.test.ts`
- `test/integration/pi-retry-characterization.test.ts`
- `test/integration/lifecycle-policy.test.ts`
- `test/integration/lifecycle-races.test.ts`
- `test/e2e/lifecycle-watchdog.test.ts`
- `test/e2e/provider-retry.test.ts`

Then run the shared release commands from the overview.

## Cluster non-goals

- no model content or partial thinking in liveness events;
- no per-token persistence or UI update;
- no claim that tool activation alone proves OS effects;
- no reconstruction of missing mutation paths from untrusted result text;
- no cancellation of the one authoritative cleanup promise at a caller deadline.
