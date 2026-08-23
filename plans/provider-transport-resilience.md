# Provider Transport Resilience Plan

Date: 2026-08-23
Status: proposed — not implemented or validated
Priority: P2 operational resilience
Classification: recurring provider/network failure signal; extension observability, settings-parity, and recovery-guidance scope; provider/core causation not established

## Executive decision

Do not add a second retry loop or a new provider-diagnostics persistence subsystem to `pi-email-subagent`.

The smallest first release should:

1. characterize Pi's actual retry event ordering and the settings received by SDK workers;
2. render `auto_retry_start` / `auto_retry_end` through the existing bounded `ActivityItem` and `currentActivity` path;
3. keep terminal failure in the existing `record.failure` path;
4. use the existing current-batch work ledger and session conversation to warn that tool effects may already exist;
5. rely on ordinary broker settlement/failure persistence and native worker session history for postmortem evidence; and
6. change worker settings construction only if a failing characterization test proves parity is missing.

All automatic retry ownership remains in Pi core/provider adapters. The extension must not automatically re-prompt, restart, re-send mail, or replay a batch after a provider error.

A new durable provider-diagnostic schema, custom session entry, or focused persistence helper is explicitly deferred. It requires separate evidence that the existing session history plus bounded registry activity/failure cannot support a concrete crash-recovery or operator decision.

## Audit evidence and measurement boundary

The source audit is the schema-parsed, deduplicated worker-history report stored as canonical email `mail_00mt5p8crh_000_4fa00188d4` in `/home/claudy/.pi/agent/subagents/01a02e21-1fb8-7cd3-b238-26fdd93c97f4/mail.jsonl` at the 2026-08-23 cutoff. Its independent review is canonical email `mail_00mt5phu0p_000_641b08e410` in the same journal.

The audit reports:

- 196 abnormal assistant attempt entries across 39 independent parent sessions;
- 64 `fetch failed` entries across 8 parents;
- 29 exact `WebSocket error` entries across 20 parents; and
- recurrent overload failures across more than one provider/parent.

These are **attempt entries, not 196 failed delegations**. The history contains sequences in which Pi automatically continued after WebSocket/provider attempts failed. The independent review specifically found retrying WebSocket attempts in two separate parents (`01a01825…` and `01a020ac-0d8f…`).

The audit establishes recurrence and operational impact, but not extension causation. It did not exhaustively map each abnormal attempt to its final run, email, or delegation outcome, run live providers, or validate a fix. Provider service, proxy, DNS, socket, adapter, credential, quota, and Pi classifier behavior remain possible branches.

All future numerical analysis must parse canonical JSONL/session event schemas, select the active session branch, deduplicate stable event identities, and distinguish low-level attempts from `agent_settled`, worker state, and mail outcomes. Grep or regex counts over JSONL are not acceptable measurements.

## Problem and attribution limits

### Confirmed extension behavior

- `src/sdk-worker.ts` receives `agent_end` with `willRetry` and suppresses `terminalAgentError(...)` when `willRetry === true`.
- A non-retrying assistant error emits the existing worker `failure`; `src/broker.ts` writes `record.failure`, marks the worker failed, retains open mail, and notifies main.
- `manage_agent restart` / `AgentBroker.restart()` creates a fresh worker around the same persistent session and mailbox, then resumes unanswered-mail enforcement or queued delivery.
- Accepted mail uses stable IDs and at-least-once crash semantics. An unanswered obligation survives a worker run failure.
- `AgentRecord.activity` is already a bounded 40-item registry field; individual worker activity summaries are already capped at 500 characters.
- The current work ledger already distinguishes explicit edit/write intent/outcomes from shell/custom unverified effects and scopes entries by accepted prompt batch.

### Confirmed Pi 0.81.1 semantics

The installed dependencies are `@earendil-works/pi-*` 0.81.1 (`package.json` / `package-lock.json`). The installed Pi SDK documents and implements:

- `agent_end.willRetry === true`: the low-level run ended but Pi will automatically retry;
- `auto_retry_start`: attempt number, maximum attempts, delay, and error;
- `auto_retry_end`: whether the retry cycle recovered and its final error when it did not;
- `agent_settled`: emitted only after the complete accepted run, including retry and compaction continuations, settles;
- `session.prompt()`: resolves after the full accepted retry cycle, while preflight acceptance is a separate earlier boundary; and
- default agent-level retry: enabled, 3 retries, 2-second exponential base delay; provider/SDK retries default to 0 and should remain 0 unless explicitly configured.

Grounding: `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`, `node_modules/@earendil-works/pi-coding-agent/docs/json.md`, `node_modules/@earendil-works/pi-coding-agent/docs/settings.md`, `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`, and `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` (`_willRetryAfterAgentEnd`, `_handlePostAgentRun`, and `_prepareRetry`).

### Unestablished attribution

An error such as `fetch failed` or `WebSocket error` does not prove a `pi-email-subagent` defect. The extension does not own the provider socket, fetch implementation, retry classifier, Codex WebSocket cache, SSE fallback, or upstream service.

The plan therefore separates:

- **provider/network remediation**: service availability, proxy/DNS/TLS, quota, credentials, endpoint behavior;
- **Pi core/adapter remediation**: transient classification, retry bounds, WebSocket/SSE behavior, transport fallback, retry lifecycle correctness; and
- **extension resilience**: settings characterization/parity, honest activity, terminal recovery guidance, and preservation of existing mail/session invariants.

## Goals

1. Make a Pi-managed retry visible in the existing activity UI without marking the worker or delegation failed.
2. Make retry recovery visible in recent activity after normal settlement.
3. Keep final worker run failure in the existing `record.failure`/failed-state path exactly once.
4. Keep email obligation state separate: an unanswered delivered request remains open, not automatically “failed work.”
5. Use the existing current-batch work ledger to warn when mutation/shell/custom tool effects may exist, without claiming absence proves safety.
6. Reuse native worker session history for detailed postmortem inspection instead of duplicating provider events into a new durable stream.
7. Honor the same trusted global/project Pi retry and transport settings as an ordinary Pi session only if a failing test proves current workers do not.
8. Give operators a safe decision path: wait, fix configuration, inspect work/session history, explicitly restart the same identity, or cancel an abandoned exact request.
9. Produce a minimal escalation artifact useful to Pi core/provider maintainers without prompts, credentials, request headers, or raw provider payloads.

## Non-goals

- eliminating provider or network outages;
- promising successful delegation after a provider failure;
- adding a new `ProviderDiagnostic` / `providerDiagnostics` record schema;
- appending a second custom diagnostic event stream to worker sessions;
- adding registry parsing, migration, or a new provider-diagnostics helper;
- guaranteeing that retry activity survives a hard crash before normal settlement;
- implementing provider failover or silently changing a worker's provider/model;
- adding provider health polling, a circuit breaker, or a reconnect daemon;
- retrying deterministic auth, quota/billing, invalid-request, context, or model errors in the extension;
- replaying an accepted email, a whole prompt batch, or a tool-using run;
- changing email address syntax, mail IDs, response obligations, or at-least-once crash semantics;
- storing raw WebSocket frames, HTTP bodies, request headers, API keys, prompts, or hidden reasoning;
- replacing Pi's retry classifier with extension-maintained error regexes.

## Invariants

1. `agent_end.willRetry === true` never emits a terminal worker failure, never sets `AgentRecord.state = "failed"`, and never sends a main-session failure alert.
2. Only a final `agent_end` with `willRetry === false` and an assistant `stopReason === "error"` enters the existing terminal `record.failure` path; the following settlement keeps that worker failed.
3. `auto_retry_start` / `auto_retry_end` add bounded activity only. They never mutate mail, failure state, lifecycle, effort, work attribution, or provider/model binding.
4. Mail delivery/answer state remains authoritative in `mail.jsonl`; activity is not a delegation outcome.
5. Pi's retry continuation is the only automatic continuation. No extension code calls `prompt()`, `restart()`, or `send()` because an error appears transient.
6. Every accepted email keeps its stable ID across Pi retry, wait, explicit same-identity restart, and crash recovery.
7. The existing work ledger remains honest: edit/write evidence is explicit, shell/custom effects are unverified, and absence of a work item is not proof that no side effect occurred.
8. A restored, unclear, or tool-using run is never labeled automatically safe to retry.
9. Activity remains within the existing 40-item / 500-character bounds and uses existing UI terminal sanitization.
10. No new provider request/response payload, header, environment value, prompt, mail body, tool argument, or thinking block is persisted for this feature.
11. Disposed/stale worker generations cannot update a replacement worker or broker record.
12. A new durable provider-diagnostics mechanism is out of scope until a separately reproduced operator/crash requirement proves existing activity, failure, work, and session history insufficient.

## Current code grounding

### Worker and Pi retry lifecycle

- `src/sdk-worker.ts:157-166` — `terminalAgentError()` returns no failure while `willRetry` is true.
- `src/sdk-worker.ts:215-287` — worker sessions use `SettingsManager.inMemory(...)`, an isolated `ModelRuntime`, and a persistent `SessionManager`.
- `src/sdk-worker.ts:291-376` — event handling tracks agent/tool/message state; it currently ignores `auto_retry_start` and `auto_retry_end`.
- `src/sdk-worker.ts:355-362` — terminal assistant errors enter the existing worker failure path.
- `src/sdk-worker.ts:364-379` — `agent_settled` decides failed versus idle and emits settlement.
- `src/sdk-worker.ts:391-414` — accepted prompts wait through the SDK session lifecycle; batches already distinguish new delivery from enforcement.
- `src/sdk-worker.ts:190-201` — `activity()` already normalizes whitespace, caps summaries at 500 characters, retains 40 items, updates current activity, and emits an existing worker event.

### Broker persistence and recovery

- `src/broker.ts:647-669` — accepted mail delivery failures are handled without inventing a reply.
- `src/broker.ts:805-914` — worker construction is bounded and failures persist.
- `src/broker.ts:977-1022` — worker `failure` events write the existing `record.failure`, mark failed once, notify main, and stop concurrency bookkeeping.
- `src/broker.ts:1000-1021` — activity/work events synchronize the worker snapshot; state/settlement already trigger registry persistence.
- `src/broker.ts:1073-1163` — queued email prompt acceptance and failure flow.
- `src/broker.ts:1190-1277` — settlement, response enforcement, and final worker state.
- `src/broker.ts:1334-1373` — explicit restart preserves address, record, session, mailbox, lifecycle, and effort.
- `src/registry-store.ts` — existing `ActivityItem`, `failure`, and work state parsing already provide bounded registry state; no new parser is needed.
- `src/work-ledger.ts` — current batch IDs and existing mutation/shell/custom items provide conservative operator evidence about possible effects.
- `src/mail-store.ts` and `src/prompts.ts` — stable envelope identity and at-least-once recipient guidance.

### Provider/runtime settings

- `src/model-runtime.ts` snapshots registered providers at extension start and resolves the exact provider/model in each isolated worker runtime.
- `src/sdk-worker.ts` currently creates in-memory settings containing steering/follow-up/default effort only. Configured `retry`, `retry.provider`, `transport`, `httpIdleTimeoutMs`, and `websocketConnectTimeoutMs` are not explicitly loaded into that settings manager.
- Pi's `SettingsManager.create(cwd, agentDir, { projectTrusted })` loads merged global/project settings, and `createAgentSession()` forwards retry, provider retry, transport, HTTP idle timeout, and WebSocket connect timeout.

This is a suspected settings-parity gap, not a proven historical cause. It must be demonstrated by a failing test before any production settings change.

## Smallest defensible design

### 1. Characterize event ordering before implementation

Use a real `AgentSession` with a deterministic provider to record the canonical sequence for:

- one retryable error followed by success;
- multiple retryable errors followed by success;
- exhausted retries;
- non-retryable error;
- abort during retry backoff; and
- a retry after a completed tool turn.

The test must establish where `agent_end`, `auto_retry_start`, `auto_retry_end`, message/tool events, and `agent_settled` occur. The implementation should follow observed/documented Pi events, not assume a convenient order.

If installed Pi semantics disagree with the documentation, stop and escalate the minimal SDK reproducer before adding extension logic.

### 2. Map Pi retry events into existing activity

Add two cases to `SdkWorker.onSessionEvent()`:

- `auto_retry_start` → existing `activity("status", ...)` with `attempt/maxAttempts`, delay, and bounded Pi error summary;
- `auto_retry_end(success=true)` → existing `activity("status", ...)` recording recovery and attempt number;
- `auto_retry_end(success=false)` → existing `activity("error", ...)` recording that the Pi retry cycle ended and its bounded final error, without emitting worker `failure` itself.

Example activity summaries:

```text
Provider retry 2/3 scheduled in 4000ms: WebSocket error
Provider retry recovered after attempt 2
Provider retry ended after attempt 3: WebSocket error
```

Rules:

- do not add a provider error taxonomy; Pi's retry disposition is the classification;
- do not emit a main failure alert for retry start/recovery;
- do not introduce a retry-cycle ID, hash, schema, custom session entry, or registry cache;
- keep provider/model visible through the existing agent profile rather than duplicating it into each activity item;
- reuse `activity()` bounds and UI sanitization; and
- let normal state/settlement handling persist the worker snapshot as it does today.

If a hard crash occurs before settlement, use the native worker session's assistant error messages, tool calls/results, and existing mail/registry state for postmortem. The first release does not promise an exact retry-start/end activity record across that crash window.

### 3. Keep terminal state in the existing failure path

Retain `terminalAgentError()` and the existing worker/broker `failure` event. Do not add a parallel terminal diagnostic.

A final failure alert and `/agents` profile should combine existing facts at render/notification time:

- `record.failure` — terminal error;
- `record.provider` / `record.modelId` — bound runtime identity;
- open inbound response-obligation count from `MailStore` — request remains open;
- current work ledger — whether mutation/shell/custom attempts in this batch mean effects may exist; and
- persistent conversation/session view — detailed tool/provider postmortem.

The failure string remains the provider error, not a serialized recovery object. Guidance belongs in notification/UI/docs.

### 4. Use the existing work ledger conservatively

Add a small query to `src/work-ledger.ts` only if UI/broker code cannot express it clearly in place:

```text
current batch contains any edit/write/shell/custom work item → effects may exist
```

Treat running, succeeded, failed, and interrupted shell/custom work as potentially effectful. Treat edit/write attempts conservatively when their outcome is not a confirmed no-op. Do not promote shell/custom effects to confirmed attribution.

If no current-batch effectful work item exists, say only:

```text
No mutation/shell/custom effect is recorded in the current work ledger.
This does not prove the run failed before all side effects; inspect the session before recovery.
```

Why absence is not proof:

- mailbox tools are activity/session events rather than work-ledger entries;
- provider failure can follow other tool classes;
- restored history may not establish an in-process pre-tool boundary; and
- external effects can occur through custom behavior not attributable to a file.

The first release therefore does not expose a `pre_tool` safety field and never uses the ledger to trigger automatic recovery.

### 5. Characterize settings parity; change only on a red test

Create a worker under temporary global and trusted project Pi settings with explicit values for:

- `retry.enabled`, `maxRetries`, and `baseDelayMs`;
- `retry.provider.maxRetries`, timeout, and max retry delay;
- `transport`;
- `httpIdleTimeoutMs`; and
- `websocketConnectTimeoutMs`.

Observe deterministic provider call options and retry events.

If the worker does not receive the expected effective policy, replace its settings construction with Pi's existing API:

```ts
SettingsManager.create(config.cwd, config.agentDir, {
  projectTrusted: config.projectTrusted,
})
```

Apply only worker-owned in-memory overrides needed for steering/follow-up and persisted effort, and pass the same manager to `DefaultResourceLoader` and `createAgentSession()`.

Required semantics if the gap is proven:

- trusted global/project policy applies;
- untrusted project settings remain ignored;
- Pi defaults are not raised;
- the extension gains no retry setting;
- provider SDK retries stay at Pi's default 0 unless the user explicitly configured otherwise; and
- settings load errors follow `SettingsManager` behavior and are surfaced as existing bounded activity/startup guidance.

If characterization passes before production changes, retain the test and omit settings code changes.

### 6. Reuse existing operator surfaces

Use:

- `/agents` Activity tab for recent retry start/end activity;
- `/agents` Work and conversation views for possible effects and postmortem;
- `/agents` Profile and `inspect_agent` for provider/model/current failure/open-mail state;
- existing main failure notification for terminal-only guidance;
- `manage_agent restart` for explicit same-identity recovery; and
- `cancel_request` only for an intentionally abandoned exact obligation after the recipient is inactive.

Do not add a recovery tool or provider-debug command.

Operator decision path:

1. Retry activity with live worker: wait; do not restart.
2. Retry recovered: no action; allow normal settlement/answer.
3. Terminal deterministic configuration error: fix provider/model/auth settings and reload if required.
4. Terminal error with current-batch work: inspect work and session before restart/redelegation; effects may exist.
5. Terminal error without recorded effectful work: still inspect session; absence is not proof of pre-tool failure.
6. When recovery is safe, restart the same identity to preserve context/mail.
7. If the user abandons the request, stop and cancel that exact request with the existing audited reason.

### 7. Define the escalation boundary

Escalate to Pi core/provider adapters when deterministic evidence shows any of:

- `willRetry` disagrees with Pi's documented transient classification;
- `agent_settled` occurs before the retry cycle completes;
- retry settings/provider options are not honored by a minimal SDK session;
- a failed provider turn causes a prior completed tool call to execute again;
- WebSocket/SSE/fetch behavior fails outside this extension in a minimal SDK reproducer; or
- retry lifecycle events are inconsistent or insufficient for honest activity.

An escalation artifact should contain Pi/package version, provider/model/API identifiers, non-secret effective retry/transport settings, ordered structured event types and timestamps, attempt/max/delay, stop reason/error summary, and tool-call IDs/outcomes. It must omit prompts, mail bodies, credentials, headers, environment values, hidden reasoning, and raw transport frames unless a maintainer explicitly requests a separately scrubbed artifact.

Provider/network remediation is appropriate when the same minimal SDK request fails due to service availability, local proxy/DNS/TLS, credentials, quota, or endpoint reachability without an adapter contract violation.

### 8. Gate any future durable diagnostics separately

Do not add provider-specific durable fields or session entries in this release.

Reopen that design only with all of the following evidence:

1. a deterministic crash/restart or real operator case loses a retry fact needed for a concrete recovery decision;
2. the native session's assistant errors/tool history, existing registry activity/failure/work, and mail state cannot answer it;
3. the missing fact cannot be recomputed safely from the active session branch;
4. the required retention/bounds/privacy contract is defined; and
5. the benefit justifies a schema/migration/recovery path.

Only then consider the narrowest durable mechanism. A desire for more telemetry or aggregate counting is not sufficient.

## Test-first implementation phases

## Phase 0 — Characterize Pi ordering and effective settings

Before production changes, add deterministic tests for:

1. retryable attempt → `agent_end.willRetry=true` → retry events → success → settlement;
2. retry exhaustion ending in `agent_end.willRetry=false`;
3. non-retryable final error;
4. abort during retry backoff;
5. completed tool turn followed by a retryable provider error; and
6. trusted/untrusted effective retry/transport settings reaching the deterministic provider.

Assertions must use the ordered event array and provider call options, not timing sleeps or text log matching.

If Pi event ordering or settings forwarding differs from the installed docs, update the plan/escalate before implementation.

Likely files:

- `test/unit/sdk-worker.test.ts`
- `test/integration/sdk-worker-start.test.ts`
- `test/helpers/fakes.ts`
- a focused deterministic provider under `test/e2e/helpers/`

## Phase 1 — Existing activity integration

Tests first:

- `auto_retry_start` creates one bounded status activity with attempt/max/delay/error;
- retry recovery creates one status activity;
- unsuccessful retry end creates activity but not a worker terminal failure by itself;
- `willRetry=true` still suppresses `terminalAgentError`;
- final non-retrying error still enters the existing worker failure path once;
- activity remains capped at the existing 40 items and 500 characters;
- no raw prompt, mail body, tool arguments, headers, provider payload, or thinking is added;
- settlement persists retry activity through the existing broker state path; and
- retry activity does not mutate mail delivery/answer state.

Likely production files:

- `src/sdk-worker.ts`

Likely tests:

- `test/unit/sdk-worker.test.ts`
- `test/integration/broker.test.ts`
- `test/unit/registry-store.test.ts` only as a regression proving the unchanged existing activity bound/parser

No new production helper, type, custom entry, or registry field is expected in this phase.

## Phase 2 — Conditional settings parity

Only if Phase 0 produces a failing parity test, load effective trusted Pi settings with `SettingsManager.create(...)` and share that manager between worker loader/session.

Tests:

- global retry and transport settings reach worker provider options;
- trusted project overrides global;
- untrusted project settings are ignored;
- worker steering/follow-up/effort behavior remains unchanged;
- settings load error uses defaults/activity without leaking file content; and
- no retry budget is raised by extension defaults.

Likely files if red:

- `src/sdk-worker.ts`
- `test/integration/sdk-worker-start.test.ts`

If characterization is green, there is no production change in this phase.

## Phase 3 — Existing work/UI/operator guidance

Add a current-batch “effects may exist” query to `src/work-ledger.ts` only if needed. Render terminal guidance from existing record/work/mail/session state.

Tests first:

- current-batch edit/write/shell/custom attempt warns that effects may exist;
- a prior-batch item does not contaminate the current warning;
- no current work item produces cautious “not recorded, not proven safe” wording;
- shell/custom remains explicitly unverified;
- retry activity appears in Activity without a notification storm;
- terminal failure remains in Profile/current failure and the open obligation remains visible;
- narrow rendering remains bounded and terminal controls are sanitized; and
- explicit restart guidance names the same identity rather than replaying mail.

Likely files:

- `src/work-ledger.ts` (only for a small existing-ledger query)
- `src/broker.ts`
- `src/ui.ts`
- `src/main-tools.ts` only if existing inspection wording cannot express the guidance
- `docs/inspect-agent.md`
- `docs/manage-agent.md`
- `docs/agents-dashboard.md`
- `docs/lifecycle.md`
- `README.md` and `docs/README.md`
- `CHANGELOG.md`

Likely tests:

- `test/unit/work-ledger.test.ts`
- `test/unit/ui.test.ts`
- `test/integration/main-tools.test.ts`
- `test/integration/broker.test.ts`
- `test/e2e/extension-load.test.ts`

## Phase 4 — Deterministic real-Pi retry proof

Extend the scripted provider used by `test/e2e/real-flow.test.ts`, or add one focused provider-retry E2E file, with no external network or paid model.

### Retry then recover before tools

- first provider call ends with a retryable WebSocket/fetch-style error;
- next call succeeds;
- assert ordered canonical RPC events, no terminal alert, one settled worker, one stable mail ID, and retry/recovery activity present in the settled registry snapshot.

### Retry after a completed tool turn

- worker performs one deterministic file mutation;
- following provider call fails transiently;
- Pi retries only that failed provider turn;
- assert the tool call/result ID and filesystem effect occur once.

### Retry budget exhausted

- configured small Pi retry budget ends terminally;
- assert one terminal notification, existing `record.failure`, failed worker, still-open delivered request, no extension-generated prompt/restart, and current-batch work warning when applicable.

### Explicit recovery

- change only deterministic provider behavior;
- call existing `manage_agent restart`;
- assert reuse of the same address, session file, mail ID/obligation, effort, and lifecycle;
- assert no repeated mutation unless the scripted model explicitly requests it.

### Native-session postmortem

- parse the worker session active branch after retry/recovery and after terminal exhaustion;
- assert assistant error messages and tool call/results provide the detailed attempt/effect evidence referenced by operator guidance;
- do not append or expect a provider-specific custom entry.

Parse RPC JSON lines, registry JSON, session JSONL, and mail JSONL by schema and stable IDs. Do not assert aggregate counts with grep.

Likely files:

- `test/e2e/helpers/mock-provider-extension.ts` or new `test/e2e/helpers/retry-provider-extension.ts`
- `test/e2e/real-flow.test.ts` or new `test/e2e/provider-retry.test.ts`
- `test/e2e/helpers/rpc-client.ts` only if a missing structured command helper is necessary

## Deterministic validation matrix

| Layer | Scenario | Required result |
|---|---|---|
| Characterization | retry then success | documented ordered Pi events through one settlement |
| Characterization | exhausted/non-retryable/aborted retry | exact final event ordering established |
| Characterization | trusted/untrusted settings | effective provider options observed, parity decision evidence-based |
| Unit | `agent_end.willRetry=true` | no terminal error/failure |
| Unit | `auto_retry_start` | existing bounded status activity only |
| Unit | retry end success | recovered activity, no failure alert |
| Unit | retry end unsuccessful | ended activity; terminal state waits for final non-retrying error |
| Unit | non-retryable assistant error | existing worker failure path, no retry invented |
| Unit | activity overflow/long error | existing 40-item / 500-character bounds hold |
| Unit | current-batch effectful work | effects-may-exist warning |
| Unit | no current-batch work | cautious not-recorded/not-proven-safe wording |
| Integration | retry events through broker | worker stays running; no main failure notification |
| Integration | recovered settlement | retry activity persists through ordinary settlement snapshot |
| Integration | terminal event through broker | existing `record.failure`; open mail remains open |
| Integration | restart after terminal error | same record/session/mail/lifecycle/effort reused |
| Integration | settings parity red case | effective trusted Pi policy reaches provider call |
| Race | shutdown during backoff | stale events cannot mutate replacement; cleanup bounded |
| Race | terminal end versus settlement | no idle-after-failure or duplicate notification |
| Real RPC | retry then success | one accepted delegation; retry observable; no extra prompt |
| Real RPC | tool then provider retry | completed tool effect occurs once |
| Real RPC | exhausted retry | failed worker/open obligation; no automatic extension recovery |
| Postmortem | parse native worker session | assistant errors/tools explain attempt/effect history without custom diagnostics |

## Acceptance and release gates

Release only when all of the following are true:

- characterization tests establish Pi retry ordering before production event handling is changed;
- retrying attempts never produce failed worker state or main failure alerts;
- retry start/end/recovery appears through existing bounded activity/current-activity paths;
- recovered activity is present after ordinary settlement using existing broker persistence;
- terminal errors use the existing `record.failure` path exactly once and preserve the open email obligation;
- operator surfaces use existing current-batch work and session history to warn about possible effects without claiming absence proves safety;
- trusted Pi settings are changed only if a failing characterization test proves the gap, and no defaults are raised;
- no provider-diagnostics type, registry field/parser/migration, session custom entry, cache, or focused provider-diagnostics helper is added;
- no extension code automatically re-prompts, restarts, re-sends, replays a batch, or changes provider/model in response to an error;
- deterministic tool-then-retry proof shows no repeated completed tool effect;
- stable mail identity and at-least-once semantics remain unchanged;
- native session history provides the promised postmortem evidence;
- targeted tests, full tests, typecheck, package smoke, and dependency/license/security gates pass from a clean baseline; and
- provider/core behavior discovered during characterization is escalated separately rather than masked in the extension.

Validation commands for implementation:

```bash
npm run check
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:package
npm run check:licenses
npm run check:secrets
```

Run each suite with complete first-run output captured to a durable artifact. On failure, inspect only the bounded summary and relevant test section; do not rerun merely to discover which test failed.

## Observability and diagnostics

### Retry activity

```text
Provider retry 2/3 scheduled in 4000ms: WebSocket error
Provider retry recovered after attempt 2
```

This is a Pi-managed attempt/cycle status. It is not red/terminal on retry start and does not increment a failed-delegation counter.

### Terminal profile/alert

```text
Terminal provider run failure · openai-codex/gpt-5.6-sol
1 delivered request remains unanswered.
Current batch includes mutation/shell/custom work; effects may exist. Inspect Work and Conversation before same-identity restart.
```

When no such current-batch work is recorded:

```text
No mutation/shell/custom effect is recorded in the current work ledger; this is not proof of pre-tool failure.
Inspect Conversation before recovery.
```

Rules:

- retry start/recovery uses existing activity, not terminal notifications;
- terminal notification happens once per terminal worker run from existing failure state;
- recent Activity is bounded by the existing 40-item record limit;
- error text uses the existing 500-character activity bound and UI terminal sanitization;
- provider/model comes from the existing profile/record;
- detailed postmortem comes from native session assistant/tool history;
- stable session/mail/tool-call IDs provide correlation; do not add an error hash;
- raw history analysis reports attempts, retry cycles, terminal runs, and mail outcomes separately; and
- no new raw provider payload is stored.

## Compatibility and migration impact

- No mail, registry, address, tool, lifecycle, effort, or session custom-entry schema changes are required.
- `ActivityItem`, `record.activity`, `currentActivity`, `record.failure`, and work state keep their current types and bounds.
- Older registries/sessions require no migration.
- Older extension versions ignore nothing new at the persistence layer because no new field/custom entry exists.
- Activity wording changes are display/derived-state compatible.
- If the settings parity test is red, loading trusted Pi settings may change workers that previously ignored custom retry/transport settings. This intended parity needs a changelog note; shipped Pi defaults are not raised.
- Provider/model catalog changes still require extension reload under the existing `WorkerRuntimeFactory` snapshot contract.
- A hard crash before normal settlement may omit retry start/end from bounded registry activity. Native session error/tool history and existing mail/failure state remain the supported postmortem sources for the first release.

## Risks and races

1. **Assumed event order** — solve with a real deterministic `AgentSession` characterization before coding.
2. **Duplicate terminal notification** — `auto_retry_end(success=false)` records activity only; final non-retrying worker failure alone notifies main.
3. **Activity overwritten as current status changes** — retry entries remain in bounded recent activity even when `currentActivity` later becomes settled/failed.
4. **Crash before settlement loses retry activity cache** — explicitly accepted for release one; inspect native session history. Do not add persistence machinery without the separate gate.
5. **False safe-boundary claim** — current work ledger evidence can prove some possible effects, not prove absence. Wording and tests must preserve this asymmetry.
6. **Mailbox/custom side effects outside current ledger summary** — direct the operator to Conversation/session history and never automate recovery.
7. **Stale worker event** — retain broker's current-worker/generation checks before synchronization/publish.
8. **Settings snapshot drift** — if parity is needed, use one manager per worker start for both loader/session and honor project trust.
9. **Provider retry multiplication** — a user-configured provider SDK retry above 0 may multiply agent-level attempts. Preserve Pi's default/warning and do not add another layer.
10. **Sensitive error content** — add no new capture source; reuse bounded error/activity and sanitize render output. Never collect headers/payload/environment.
11. **Operator restart after effects** — guidance must require inspection and present restart as explicit, not automatic or risk-free.
12. **Activity notification storm** — activity updates may publish UI state but must not call main failure notification for each attempt.

## Rollout

1. Land event-order/settings characterization tests first.
2. If ordering matches the contract, add the two existing-activity event cases.
3. If and only if settings parity is red, change worker settings construction and retain the regression.
4. Add existing-ledger/operator wording without new state.
5. Run deterministic real-Pi provider scenarios with provider SDK retries at default 0 first, then one explicit settings-parity case if relevant.
6. Release as observability/recovery hardening, not as a provider-outage fix.
7. Monitor parsed attempt, terminal-run, and mail-outcome events separately; do not compare a terminal-run count with the historical 196 attempt entries.
8. Keep extension-level automatic retry disabled.
9. Revisit durable provider diagnostics only after the separate evidence gate is met.

## Rejected overengineering

### Provider-specific custom session entries and registry cache

Rejected for the first release. Native session assistant/tool history is already durable postmortem evidence, bounded activity persists on settlement, and terminal failure already persists immediately. A second stream/cache/parser/migration path needs a demonstrated operator requirement.

### A new `provider-diagnostics.ts` subsystem

Rejected. Two event cases can use the existing `activity()` function. Work-risk guidance can reuse the existing work ledger.

### A second extension retry loop

Rejected. Pi already owns retry classification, budget, backoff, abort, and continuation. A second loop multiplies attempts and can duplicate side effects.

### Automatic `manage_agent restart` on transient-looking text

Rejected. Restart resumes a persistent session after a terminal run; it is not the same low-level provider retry and can re-enter work after completed tools.

### Re-sending or reformatting the original email

Rejected. The accepted envelope and response obligation already persist. A new envelope creates another ID/obligation; replaying the old formatted prompt risks duplicate work.

### Error-string taxonomy in this extension

Rejected. Pi core/provider adapters own retry classification and evolve it with provider behavior. The extension records Pi's disposition and a bounded summary without forking those regexes.

### Provider failover or silent model switching

Rejected. Provider/model is part of a persistent agent binding. Failover changes behavior, auth, context compatibility, cost, and tool decisions. Provider-aware binding is handled separately by `plans/provider-aware-model-routing.md`.

### Health daemon, circuit breaker, or global provider score

Rejected. No evidence requires continuous polling or cross-session state. It adds network traffic, stale health, shutdown races, and another persistence subsystem.

### Raw transport capture

Rejected. WebSocket frames, HTTP bodies, headers, and full payloads are sensitive and unnecessary for the first observability boundary.

### Error hashes or deduplication fingerprints

Rejected. Stable session, mail, and tool-call IDs already exist; no new hash mechanism is needed.

## Expected first-release scope

Expected production changes are deliberately small:

- `src/sdk-worker.ts`: activity mapping for Pi retry lifecycle;
- optionally `src/work-ledger.ts`, `src/broker.ts`, and `src/ui.ts`: existing-state effect warning/operator wording;
- conditionally `src/sdk-worker.ts` settings construction, only after a red parity test;
- focused tests and documentation listed above.

Not expected:

- `src/types.ts` provider-diagnostic additions;
- `src/registry-store.ts` provider-diagnostic parsing/migration;
- session custom diagnostic entries;
- a provider diagnostic cache/helper;
- crash-window cache reconstruction; or
- any automatic retry/restart/re-prompt code.

## Not validated during planning

No repository tests, live providers, mock-provider runs, TUI checks, package builds, or source changes were performed while writing or revising this plan. The historical counts come from the cited parsed audit artifact; the present plan inspection grounded current HEAD and installed Pi 0.81.1 semantics only.
