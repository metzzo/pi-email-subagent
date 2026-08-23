# Agent Identity-Capacity and Obligation-Recovery Plan

Date: 2026-08-23
Status: proposed — test-first implementation not started
Priority: P3 operability / recovery UX
Classification: recurring fail-closed safety friction and observability gap; **the capacity limit and archival refusal are deliberate, not correctness bugs**

## Executive decision

Keep the existing safety model and defaults. Improve the surfaces operators and coordinators already use:

1. make `maxAgents` identity/activation capacity visibly distinct from `maxConcurrent` run concurrency;
2. expose exact capacity use and whether a selected identity holds a lease;
3. make `send_email`, `inspect_agent`, `/agents`, and `manage_agent` errors/results give a short, safe recovery ladder;
4. make archival blockers actionable with bounded counts and real request IDs, but no automatic cancellation or archival;
5. prove stop/restart/cancel/archive races and fail-closed behavior with deterministic tests and real Pi RPC events.

Do not raise defaults blindly, auto-stop workers, auto-cancel substantive obligations, auto-archive identities, or build a new orchestration subsystem. The smallest defensible design is additive diagnostics plus bounded derived capacity/obligation summaries on existing tools and UI.

## Audit evidence

The structured audit supplied for this issue found native `Agent limit reached (8)` failures in at least five independent downstream parents. At the audit cutoff, some capacity holders or overflow identities were inactive while real response obligations remained assigned to them, making manual recovery difficult.

The audit also established the important distinction:

- `maxAgents = 8` is the default maximum number of active registered identities holding activation leases;
- `maxConcurrent = 4` is the default maximum number of workers running simultaneously.

Those are separate limits. Waiting for a run slot or stopping a worker does not, by itself, free an identity lease.

The recurrence count is a supplied canonical-history result; this planning pass did not recalculate it. Current HEAD inspected for this plan is `6e869743957f8f5b8be99dc642af2345c9ce7ee7` (2026-08-17).

## Problem statement

The broker correctly refuses to create or restore an identity when every activation lease is in use. The current error is usually:

```text
Agent limit reached (8); archive or reuse an existing address.
```

That instruction is directionally correct but omits the information needed to act safely:

- whether the full resource is identity capacity or concurrent execution;
- how many leases and run slots are in use;
- whether stop frees capacity (it does not);
- which existing lifecycle actions are appropriate in which order;
- why archival is refused;
- which exact open requests block an inactive identity;
- when cancellation is permitted and why it must never stand in for substantive completion.

`inspect_agent` exposes only a binary `capacityAvailable`. `/agents` shows total agents and collapses `paused`, `stopped`, and `archived` to the same operator label, `closed`. Its Inbox helps with incoming obligations once an operator selects an agent, but the header does not show lease use, the Profile tab does not show the underlying capacity state, and archival failures report only a generic blocker.

The result is manual trial and error precisely when the broker is correctly failing closed.

## Root mechanism

### Identity capacity

`src/broker.ts` maintains `activationLeases`. `activeIdentityCount()` is the set size. A non-archived routable identity normally retains its lease across idle and stopped states. An archived identity releases its lease while retaining its record, session, and mail.

Unknown sends and restoration/restart paths check `activationLeases.size` against `config.maxAgents`. They refuse before allocating a new lease when full. Startup also preserves overflow records when a configured limit is lowered, marks them `paused`, and activates only the first bounded set.

### Run concurrency

The separate `active` set and `pendingStarts` queue are governed by `config.maxConcurrent`. `pump()` starts queued work only while a run slot is available. This limits simultaneous execution, not identity count.

### Obligation safety

An identity cannot be archived if it is running/spawning/streaming or if mail inspection finds queued mail or open obligations in either direction. `cancel_request` can close one exact request only from the main thread, only after the recipient is inactive, and only with a substantive audit reason. Reply reservation and cancellation are serialized so neither can silently beat the other.

These mechanisms deliberately prevent capacity pressure from deleting work or fabricating success.

## Correctness versus UX classification

### Confirmed by-design safety

- Creation/restoration fails closed at `maxAgents`.
- `maxConcurrent` queues work and does not expand identity capacity.
- `stop` ends a worker run but retains its identity/session/mail and activation lease.
- `restart` resumes the same identity and requires a lease if the identity no longer holds one.
- `archive` is the explicit operation that frees a lease.
- Archival refuses queued mail and open obligations in either direction.
- Cancellation is main-only, exact-ID, inactive-recipient-only, reasoned, durable, and not a reply.
- Archived restoration keeps the original persistent identity, effort, lifecycle, session, and mail.

### UX and diagnostics gap to fix

- Capacity errors do not distinguish identity leases from run slots.
- Binary `capacityAvailable` does not explain total use or whether the target already holds a lease.
- `/agents` does not display capacity totals and its `closed` label hides the precise recovery-relevant state.
- `stop` results do not warn that the lease remains held.
- Archival failure does not enumerate bounded blocker categories or exact request IDs.
- Current guidance says “archive or reuse” without a safe ordered decision path.

### What would be a correctness defect

Treat any deterministic evidence of the following as a blocking correctness defect, not as UX friction:

- more than `maxAgents` activation leases after parallel sends/restarts/restores;
- an unknown-recipient request journaled as accepted after the pre-accept capacity check rejects it;
- stop unexpectedly releasing or losing persistent identity state;
- archive succeeding while queued/open obligations exist;
- cancellation of active work, incoming main mail, an answered request, or a reply-reserved request;
- archive/cancel racing with reply delivery and leaving an impossible terminal state;
- a released lease not becoming available after successful archive;
- a restored-overflow identity running without a lease.

The existing implementation is intended to prevent these cases. Characterization tests must protect that behavior before diagnostics change.

## Goals

1. Make identity capacity and run concurrency understandable at a glance.
2. Give main and downstream parents an actionable, safe response to capacity rejection.
3. Make reuse, restart, stop, cancel, and archive roles explicit and ordered.
4. Expose enough blocker information to recover without dumping private mail content.
5. Preserve every fail-closed and audited-obligation invariant.
6. Keep changes additive and bounded; reuse `inspect_agent`, `/agents`, `manage_agent`, `cancel_request`, and existing broker state.
7. Measure recurrence and recovery from canonical structured events without paid/live-provider dependence.

## Non-goals

- Raising `maxAgents` or `maxConcurrent` defaults.
- Automatically resizing limits based on demand.
- Automatically stopping, cancelling, archiving, evicting, or deleting identities.
- Treating cancellation as successful work.
- Creating an LRU agent pool or a new scheduler.
- Adding a new capacity-management tool when existing tools can express the recovery.
- Merging `maxAgents` and `maxConcurrent` into one limit.
- Allowing subagents to invoke main-only lifecycle/cancellation operations.
- Showing subjects, bodies, or a global identity directory inside a `send_email` failure.
- Solving semantic task assignment or deciding which identity is “relevant” automatically.
- Changing persistent session, effort, lifecycle, or address semantics.

## Invariants

1. **Hard identity cap:** activation leases never exceed `maxAgents`, including parallel unknown sends, restores, restarts, reloads, and config-limit reductions.
2. **Separate run cap:** active worker runs never exceed `maxConcurrent`; a free run slot is not reported as a free identity slot.
3. **Pre-accept refusal:** a capacity-rejected unknown send creates no envelope, recipient record, worker, or reply obligation.
4. **Persistent stop:** stop aborts/disposes the worker but retains the record, session, mail, and activation lease; diagnostics must never say stop frees identity capacity.
5. **Explicit release:** only successful clean archival (or existing startup quarantine behavior for unroutable records) releases a normal identity lease.
6. **Archival refusal:** queued mail or open obligations in either direction continue to block archive.
7. **Main-only administration:** `manage_agent` and `cancel_request` remain main-thread-only; subagents receive only `send_email` and `fetch_emails` plus configured work tools.
8. **Exact audited cancellation:** cancellation requires a real request ID, inactive recipient, substantive bounded reason, and durable `email.cancelled` transition; it never writes `answeredAt` or fabricates reply text.
9. **Reply/cancel atomicity:** a reserved reply beats cancellation, or cancellation beats the reply; there is no double terminal outcome.
10. **No automatic abandonment:** capacity pressure alone is never a reason to cancel substantive open work.
11. **Restoration compatibility:** archived mail/restoration retains the original session, effort, lifecycle policy, and address.
12. **Bounded diagnostics:** candidate/blocker output has explicit caps and omission counts; no mail body is added to errors, widgets, headers, or capacity summaries.
13. **Privacy by role:** a subagent capacity error does not reveal other agents' addresses or subjects. Main/operator surfaces may show identities already present in `/agents`, but capacity summaries still omit mail bodies and subjects by default.
14. **Canonical evidence:** tests parse tool result details, broker snapshots, RPC events, and journal JSON. Counts are never inferred with grep/regex over structured artifacts.

## Current code grounding

### Configuration and types

`src/config.ts`

- defines defaults `maxAgents: 8` and `maxConcurrent: 4`;
- validates `maxAgents` up to 64 and `maxConcurrent` up to 32, clamped to `maxAgents`.

`src/types.ts`

- `SubagentConfig` contains both limits;
- `AgentInspection` has binary `capacityAvailable` plus state and three mailbox counts;
- `BrokerSnapshot` currently contains main address, agent records, total unanswered, and queued mail, but no limit/use summary.

`docs/configuration.md`

- accurately calls `maxAgents` active registered identities/activation leases and `maxConcurrent` simultaneously running workers.

### Broker capacity and recovery

`src/broker.ts`

- `activeIdentityCount()` returns `activationLeases.size`;
- unknown-send checks at the validation and lease-acquisition boundaries currently emit similar but not identical `Agent limit reached` strings;
- `ensureWorker()` and `restart()` also enforce the cap when an address lacks a lease;
- startup leases at most `maxAgents` routable non-archived records and marks overflow records `paused`;
- `pump()` enforces `maxConcurrent` through `active` and `pendingStarts`;
- `stop()` retains the activation lease;
- `archive()` releases the lease only after checking state and all queued/open mail in both directions;
- `cancelRequest()` enforces main-only exposure through the tool surface, inactive recipient, exact correlation, bounded reason, and reply-reservation exclusion;
- `inspectAgent()` calculates binary availability and incoming mailbox counts;
- `getSnapshot()` does not expose capacity totals.

### Existing tool surfaces

`src/sdk-worker.ts`

- defines `send_email` for main and workers and wraps broker failures as native tool errors;
- its failure text preserves the broker diagnostic;
- subagents cannot call lifecycle or cancellation tools.

`src/main-tools.ts`

- renders `inspect_agent` with only `Capacity available: yes/no`;
- renders `manage_agent` as a generic action/state result;
- already documents main-only audited cancellation and archive-clean guidance.

`src/prompts.ts`

- tells main to reuse relevant identities and archive clean stopped identities;
- does not give the full capacity-recovery order or distinguish stop from lease release;
- shared subagent guidance does not say what to do when an unknown spawn hits identity capacity.

### Existing `/agents` UI

`src/ui.ts`

- header shows total agent records, unanswered mail, queued mail, and path conflicts;
- widget shows running/queued/idle/failed/closed counts;
- `paused`, `stopped`, and `archived` deliberately render as `closed` in list and detail;
- detail has Work, Activity, Inbox, and Profile/Lifecycle tabs;
- Inbox explicitly shows incoming unanswered IDs, senders, subjects, and bounded body excerpts;
- Profile currently shows tools and failure only;
- stop/restart/archive actions already exist and should be enriched rather than replaced.

`docs/agents-dashboard.md`

- documents the simplified `closed` label and Inbox cancellation flow.

### Existing tests to extend

- `test/integration/broker.test.ts`: cap-before-acceptance, cancellation, stop/restart, snapshot behavior.
- `test/integration/hardening.test.ts`: limit reduction/paused overflow, archive/reuse/restore, open outbound archival refusal, collector/cancellation races.
- `test/integration/parallel-spawn.test.ts`: concurrent same-recipient creation.
- `test/integration/main-tools.test.ts`: inspect/manage tool rendering and schema.
- `test/integration/tools.test.ts`: native `send_email` error propagation.
- `test/unit/prompts.test.ts`: coordination guidance.
- `test/unit/ui.test.ts`: dashboard widths, closed states, Inbox/work/detail behavior.
- `test/e2e/helpers/mock-provider-extension.ts` and `test/e2e/real-flow.test.ts`: deterministic native tool/RPC lifecycle.

### Existing documentation

- `docs/send-email.md`
- `docs/inspect-agent.md`
- `docs/manage-agent.md`
- `docs/cancel-request.md`
- `docs/configuration.md`
- `docs/agents-dashboard.md`
- `README.md`

These already contain most safety semantics; the implementation should align and cross-link them rather than create a separate capacity manual.

## Smallest defensible design

## 1. Add one derived capacity snapshot

Add an additive, non-persisted structure in `src/types.ts`:

```ts
interface AgentCapacitySnapshot {
  identitiesUsed: number;
  identitiesLimit: number;
  runSlotsUsed: number;
  runSlotsLimit: number;
}
```

Expose it as:

- `BrokerSnapshot.capacity` for `/agents` and the widget;
- `AgentInspection.capacity` for `inspect_agent`;
- retain `AgentInspection.capacityAvailable` for compatibility;
- add `AgentInspection.holdsActivationLease` so “existing” is not incorrectly equated with “consumes capacity.”

`runSlotsUsed` must come from the broker's actual `active` lease set, not from text labels or a count of records whose last persisted state happens to be `running`.

Do not persist this structure in the registry. It is a current derived view over authoritative broker sets and configuration.

## 2. Add a bounded obligation summary to inspection

Extend `AgentInspection` additively with:

- `outgoingUnanswered`: delivered response-required requests sent by this identity that remain unanswered and unreserved;
- `archiveEligible`: the result of the same blocker rules used by `archive()`, excluding only a cleanup error that cannot be known before the attempt.

Keep existing `queued`, `unanswered`, and `pendingReplies` fields. Do not add subjects or bodies to structured capacity details.

To prevent inspection and archive from drifting, introduce one small private/pure broker helper that classifies archive blockers from canonical `EmailEnvelope` fields. It may retain internal arrays for formatting exact request IDs, but it must not become a new state store.

Suggested internal categories:

- running/spawning/streaming state;
- queued inbound or outbound mail;
- inbound unanswered request IDs;
- outbound unanswered request IDs;
- reply-reserved/pending-delivery request IDs.

The helper should cap rendered IDs (for example, five total per category) and state how many were omitted. The counts must be computed by parsing the in-memory envelope objects, not by text scanning the journal.

## 3. Centralize the capacity-full diagnostic

Replace inconsistent broker strings with one bounded formatter used by unknown-send, ensure/restore, and restart capacity failures. It should say, in plain terms:

```text
Agent identity capacity is full (8/8 activation leases). Run concurrency is separate (2/4 slots currently used); waiting for a run slot or stopping an agent does not free an identity lease. Reuse a relevant existing address, or ask main to resolve real obligations and archive a clean identity before retrying.
```

Rules:

- never list other addresses, subjects, or bodies in a `send_email` failure;
- never recommend raising a default;
- never say to cancel merely for capacity;
- make clear that the rejected pre-accept send has no accepted request in the corresponding test, while avoiding a misleading blanket statement in post-accept lifecycle failure wrappers;
- for a downstream parent, explicitly identify main as the only actor that can cancel/archive;
- for main, point to `inspect_agent` and `/agents` without creating a new command.

A single formatter reduces message drift; it is not a capacity manager.

## 4. Enrich existing `inspect_agent`

Keep the address parameter and no-spawn behavior. Add lines such as:

```text
Identity capacity: 8/8 used · this address holds a lease: yes · capacity available for this address: yes
Run concurrency: 2/4 slots used
Mailbox: 0 queued · 1 incoming unanswered · 1 outgoing unanswered · 0 pending replies
Archive eligible: no
Recovery: restart this inactive identity to finish real obligations; cancel only an explicitly abandoned request; archive only after blockers are clear.
```

Guidance must branch on actual state:

- prospective + full: reuse a known relevant identity or ask main to free a clean lease;
- idle/running/queued with lease: reuse is capacity-safe, subject to task relevance;
- stopped/failed with genuine work: restart is the normal recovery;
- stopped does not free capacity;
- clean inactive/idle lease holder: archive can free capacity;
- archived: restoration needs a free lease;
- paused overflow: it has no live worker and may require capacity before restart; resolve/retain obligations rather than pretending it completed.

Do not list global candidates from `inspect_agent`; that would turn one-address inspection into an identity directory and could leak unrelated work.

## 5. Make archive refusal actionable

Keep refusal absolute. Improve only its error text, using the shared blocker classification:

```text
Agent cannot be archived: 1 incoming unanswered request (mail_…), 1 outgoing unanswered request (mail_…), 0 queued mail. Restart/finish genuine work. If the user explicitly abandons a request and its recipient is inactive, cancel that exact ID with a substantive reason, then retry archive.
```

Requirements:

- list only bounded real mail/request IDs and direction/state;
- never include subject, body, or counterparty address;
- distinguish queued mail (must be delivered/recovered) from cancellable requests;
- do not imply every listed request is currently cancellable; inactive-recipient validation remains authoritative in `cancelRequest()`;
- retain the existing error for running/spawning/streaming, enriched with “stop and settle first” but not “stop frees capacity.”

## 6. Enrich `manage_agent` results

Use the post-action inspection/capacity snapshot already read by `src/main-tools.ts`:

- `stop`: state that the identity lease remains held and stop alone does not free `maxAgents` capacity;
- `restart`: state that the same persistent session/mail is being resumed and report capacity;
- `archive`: state that the lease was released and report the new use/limit;
- `clear_failure`: do not imply that clearing a diagnostic resolves an obligation.

Keep `ManageAgentToolDetails` additive and bounded if capacity fields are exposed there. Do not add compound actions such as `stop_and_archive`.

## 7. Enrich `/agents`, not replace it

Use `BrokerSnapshot.capacity` in the existing header and below-editor widget:

```text
identity capacity 8/8 FULL · run slots 2/4
```

When full, show a concise hint in the dashboard header/help: select a relevant identity, inspect Profile/Lifecycle and Inbox, then reuse/restart or cleanly archive. Do not put this long hint in the one-line widget.

In the selected agent's existing Profile/Lifecycle tab, show:

- exact internal state (`paused`, `stopped`, or `archived`) even though list status remains the simpler `closed` label;
- lease held/free;
- global identity and run-slot use/limits;
- incoming/outgoing obligation counts and archive eligibility;
- the safe next action derived from state.

Keep Work as the default tab. Keep incoming mail subject/body excerpts only in the explicit Inbox tab as today. Do not add subjects or bodies to list rows, headers, widgets, capacity warnings, or Profile.

The initial implementation does not need a fifth “Capacity” tab, bulk action UI, candidate ranking, or automatic action.

## 8. Align prompts and docs

Add one concise recovery ladder to `mainCoordinatorPrompt()`:

1. reuse a relevant existing identity when appropriate;
2. restart a stopped/failed identity when real assigned work should continue;
3. stop only to make an active identity inactive—stop does not free its lease;
4. cancel an exact request only when the user explicitly abandons it and the recipient is inactive;
5. archive only after all queued/open obligations are resolved;
6. retry the new identity after archive frees capacity.

In shared/subagent guidance, explain that `Agent limit reached` means identity capacity, not run concurrency; the subagent should reuse an address it already knows or report the blocker to main. It must not invent replacement identities repeatedly or expect waiting for `maxConcurrent` to fix the cap.

Update existing docs rather than adding a new orchestration subsystem document.

## Recovery decision table

| Observed condition | Safe next action | Capacity effect | Forbidden shortcut |
|---|---|---:|---|
| relevant existing idle/running/queued identity holds lease | send/reuse that exact address | no new lease | create a synonym identity |
| stopped identity holds lease and real work remains | `restart` | lease count unchanged | cancel genuine work |
| failed identity with recoverable work | inspect failure, then at most one justified restart/recovery | lease count usually unchanged | clear failure and pretend work completed |
| active identity must be retired | `stop`, wait for settlement/cleanup, resolve obligations | lease still held | assume stop freed a slot |
| inactive recipient has an explicitly abandoned exact request | `cancel_request(request_id, reason)` | obligation closes; lease still held | cancel by subject/count or without user abandonment |
| inactive/idle identity is clean | `archive` | releases one lease | auto-archive based on age |
| archived identity should resume but capacity is full | archive another clean lease holder or reuse a leased identity | restoration consumes a lease | exceed `maxAgents` |
| overflow identity is `paused` after config reduction | keep fail-closed; resolve via main and available capacity | no implicit lease | treat paused as a completed answer |
| only `maxConcurrent` is full | wait for scheduling; do not archive for that reason alone | identity count unchanged | raise `maxAgents` |

## Test-first implementation phases

### Phase 0 — Characterize safety before diagnostics

Add focused tests around current authoritative behavior before changing messages:

1. With `maxAgents: 1`, accept one unknown recipient and reject a second before any second envelope/record/worker exists.
2. Show that `maxConcurrent: 1` queues a second already-leased identity while `maxAgents: 2` still permits both identities.
3. Stop the sole identity and assert the identity count remains 1/1 and a new identity is still rejected.
4. Resolve the identity's mail, archive it, and assert capacity becomes 0/1 and a new identity can be accepted.
5. Attempt archive with one incoming unanswered and one outgoing unanswered request; assert refusal and unchanged lease/mail state.
6. Reserve a reply concurrently with cancellation/archive checks; assert the existing atomic winner and no fabricated answer.
7. Reduce `maxAgents` across restart; assert overflow identities remain recorded/paused and only the allowed number holds leases/runs.

If any of these fail, fix the correctness issue separately before enriching messages.

Likely files:

- `test/integration/broker.test.ts`
- `test/integration/hardening.test.ts`
- `test/integration/parallel-spawn.test.ts`

### Phase 1 — Add capacity and blocker data tests

Write failing tests for:

- exact `BrokerSnapshot.capacity` values through create, queue, run, settle, stop, archive, and restart;
- exact `AgentInspection.capacity`, `holdsActivationLease`, `outgoingUnanswered`, and `archiveEligible` values;
- `runSlotsUsed` sourced from active scheduling state rather than record labels;
- archive blocker classification for queued mail, inbound/outbound unanswered, reply reservation, and running state;
- bounded blocker ID formatting with an omitted count;
- no subject/body/counterparty address in diagnostics.

Then implement the smallest derived helpers and additive interfaces.

Likely files:

- `src/types.ts`
- `src/broker.ts`
- `test/integration/broker.test.ts`
- `test/integration/hardening.test.ts`

Do not modify `src/mail-store.ts` or registry schemas unless a failing test proves the in-memory canonical envelope view is insufficient.

### Phase 2 — Add failing tool/error/prompt tests

Before changing user-visible text, test:

- capacity-full send error names identity use/limit and distinct run slots;
- the error says stop does not free a lease and points downstream parents to main;
- the error lists no other addresses, subjects, or bodies;
- `inspect_agent` keeps binary `capacityAvailable` and adds exact capacity/lease/obligation/eligibility output;
- stop result warns that capacity remains used;
- archive success reports released capacity;
- archive refusal includes bounded real request IDs, direction/counts, and safe cancellation wording;
- main prompt contains the ordered recovery ladder and preserves audited-cancellation rules;
- subagent/shared prompt distinguishes `maxAgents` from `maxConcurrent` and does not authorize lifecycle actions.

Likely files:

- `test/integration/main-tools.test.ts`
- `test/integration/tools.test.ts`
- `test/unit/prompts.test.ts`

Then make focused edits in:

- `src/broker.ts`
- `src/main-tools.ts`
- `src/prompts.ts`
- `src/sdk-worker.ts` only if a compact tool guideline is needed; broker error propagation itself should remain native.

### Phase 3 — Enrich the existing dashboard

Write UI tests first for:

- header capacity at empty, partial, full, and overflow-restored states;
- distinct identity and run-slot labels at 20, 40, 80, and 120 columns;
- `FULL` warning only when used reaches limit;
- exact internal lifecycle state visible in Profile while list/detail summary may retain `closed`;
- lease status, obligation counts, archive eligibility, and state-specific recovery hint;
- no subject/body/address-directory leakage outside the explicit Inbox/selected-agent context;
- bounded rows in short/tall viewports and no line wider than terminal width;
- actions and existing Work/Activity/Inbox/Profile navigation unchanged.

Likely files:

- `src/ui.ts`
- `test/unit/ui.test.ts`

Use the existing `DashboardComponent`, `UIController`, snapshot subscription, and selected-agent inspection. Do not add a new modal framework.

### Phase 4 — Deterministic recovery integration

Add broker integration scenarios for the full ordered recovery:

#### Reuse/restart path

- fill identity capacity;
- reuse the existing address without allocating a lease;
- stop it and show capacity remains full;
- send to the stopped identity (queued with existing disposition), restart it, and prove the persistent mail/session path resumes.

#### Cancel/archive path

- fill identity capacity with an exact main-originated open request;
- fail a second unknown send before acceptance;
- show archive refusal while work/obligation remains;
- stop the recipient;
- make explicit test-owner abandonment part of the scenario;
- cancel the exact real request with a substantive reason;
- archive the now-clean identity;
- retry the new identity and prove it is accepted;
- parse the journal and assert one `email.cancelled` transition, no `answeredAt` on the cancelled request, and one released/reacquired lease sequence in snapshots.

No production path may perform those steps automatically; the test calls each existing action explicitly.

Likely files:

- `test/integration/broker.test.ts`
- `test/integration/hardening.test.ts`

### Phase 5 — Real Pi RPC acceptance without paid providers

Extend the deterministic mock provider with one explicit capacity-recovery script. Use structured RPC events to prove:

1. first `send_email` is accepted with a real ID;
2. second unknown `send_email` ends as a native `isError: true` event whose text distinguishes 1/1 identity capacity from run slots;
3. no second request appears in the parsed journal after rejection;
4. `manage_agent archive` fails while its invariant is unmet;
5. explicit `manage_agent stop`, `cancel_request` with a real ID/reason, and `manage_agent archive` each produce separate native tool events;
6. the retry send succeeds only after archive;
7. no hidden bulk/automatic action occurred between those tool calls.

Use `PiRpcClient.events()`, structured tool arguments/details, and parsed journal entries. Never derive event counts with grep or regex against JSONL.

Likely files:

- `test/e2e/helpers/mock-provider-extension.ts`
- `test/e2e/real-flow.test.ts`

### Phase 6 — Documentation and release evidence

Update:

- `docs/configuration.md`: retain and emphasize identity versus run limits;
- `docs/send-email.md`: capacity failure meaning and downstream recovery;
- `docs/inspect-agent.md`: new capacity/lease/obligation fields;
- `docs/manage-agent.md`: stop does not free capacity, actionable archive blockers, explicit recovery order;
- `docs/cancel-request.md`: capacity pressure alone is not abandonment;
- `docs/agents-dashboard.md`: capacity header/Profile behavior and privacy boundary;
- `README.md`: concise high-level distinction and recovery link.

Do not create a migration guide because no persistent schema migration is planned.

## Deterministic validation matrix

### Capacity accounting

- 0/N, partial, full, and post-archive snapshots;
- `maxAgents = 1` with `maxConcurrent = 1`;
- `maxAgents > maxConcurrent` with queued run and available identity distinction;
- parallel unknown addresses at the final slot;
- concurrent same-address spawn acquires one identity;
- archived restore when free/full;
- restart of leased versus lease-free identity;
- config reduction with paused overflow;
- unroutable restored records remain inspectable without consuming a lease, per existing behavior.

### Acceptance and durability

- capacity rejection before mail acceptance creates no envelope/record/obligation;
- a different post-accept lifecycle failure remains explicitly reported as persisted, not mislabeled as pre-accept rejection;
- registry persistence and restart reconstruct the same lease-selection behavior;
- successful archive releases exactly one lease;
- stopped/idle persistence retains session and mail.

### Obligation safety

- incoming unanswered blocks archive;
- outgoing unanswered blocks archive;
- queued request/reply blocks archive;
- reply reservation blocks cancellation/archive appropriately;
- active recipient blocks cancellation;
- incoming request addressed to main cannot be cancelled;
- cancellation reason byte/length bounds remain;
- cancellation is idempotent and keeps the first actor/time/reason;
- cancelled is never answered and late reply fails;
- explicit stop → cancel → archive succeeds only in that safe order.

### Diagnostics and privacy

- capacity full error names both limits and current use;
- stop result states lease retained;
- archive refusal includes bounded IDs and omission counts;
- no capacity error/header/widget/Profile includes subject or body;
- no downstream-parent error enumerates unrelated addresses;
- explicit selected Inbox behavior remains unchanged and documented;
- all peer-controlled labels are sanitized and bounded.

### Tool and prompt compatibility

- `capacityAvailable` remains present;
- new structured fields match visible text;
- tool names, schemas, and main-only exposure remain unchanged;
- worker active tools still exclude inspect/manage/cancel/wait;
- main prompt orders safe recovery;
- subagent prompt tells the worker to reuse known identity or report to main without granting management authority.

### UI

- 20/40/80/120 columns;
- short/tall viewports;
- no line/row overflow;
- full warning and capacity distinction;
- exact internal state in Profile;
- keyboard actions/navigation unchanged;
- theme invalidation and control-sequence sanitization remain.

### Real scripted-provider RPC

- native error/success event order for reject → stop → cancel → archive → retry;
- structured details and real correlation IDs;
- parsed journal cancellation and absence of rejected mail;
- no paid model/network dependency.

### Package/regression

After focused red/green loops, preserve complete first-run output in durable artifacts and run:

```bash
npm run check
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:package
```

On failure, inspect the saved runner summary and exact failing sections. Do not rely on a filtered pipe, truncated terminal output, or a rerun to discover which test failed.

## Acceptance criteria

The release is acceptable only when:

1. all capacity surfaces call `maxAgents` identity/activation capacity and show used/limit;
2. run-slot use/`maxConcurrent` is visibly separate;
3. a rejected unknown send remains unaccepted and leaves no obligation;
4. `inspect_agent` reports capacity, lease status, incoming/outgoing obligation counts, and archive eligibility without spawning;
5. `/agents` shows global capacity and selected-agent recovery facts without adding private mail content outside Inbox;
6. stop visibly retains the lease; archive visibly releases it;
7. archive refusal gives bounded, actionable blocker categories and exact request IDs while refusing the action;
8. recovery guidance orders reuse/restart/stop/cancel/archive safely;
9. cancellation and management remain main-only and no action is automatic;
10. deterministic integration and RPC scenarios prove fail-closed recovery from canonical events;
11. no persistent schema migration or default-limit increase is introduced;
12. full deterministic gates pass from preserved first-run artifacts.

## Release gates

- **Cap gate:** no race may exceed `maxAgents` or `maxConcurrent`.
- **Acceptance gate:** capacity rejection occurs before journaling for unknown sends.
- **Obligation gate:** no archival with queued/open obligations.
- **Cancellation gate:** main-only, inactive recipient, exact real ID, substantive reason, durable audit event, and no fabricated answer.
- **Privacy gate:** no new subject/body/global-address disclosure in errors, headers, widgets, Profile, or aggregate metrics.
- **Compatibility gate:** existing fields and tool/action names remain; additions are additive.
- **No-default-change gate:** `8` and `4` remain defaults unless a separate capacity-sizing study justifies a config change.
- **No-automation gate:** recovery steps remain explicit individually audited calls.
- **No-paid gate:** deterministic fake/scripted providers cover release acceptance.

## Observability and diagnostics

### Runtime surfaces

Use current in-memory authoritative state rather than new logs:

- `activationLeases.size` / `maxAgents`;
- `active.size` / `maxConcurrent`;
- canonical mail envelopes for queued/open/reserved blockers;
- exact request IDs for explicit recovery;
- existing agent state, failure, activity, and session record.

Expose the derived snapshot through current broker updates, `inspect_agent`, tool result/error text, and `/agents`. Do not persist a second capacity ledger.

### Failure diagnostics

A capacity diagnostic should always answer:

1. Which resource is full?
2. What is used/limit?
3. Is run concurrency distinct/currently full?
4. Does stop free the resource?
5. What safe explicit actions exist?
6. Which actions remain main-only?

An archive diagnostic should answer:

1. Which blocker categories exist?
2. How many?
3. Which bounded real request IDs are relevant?
4. Which IDs were omitted due to caps?
5. What is the safe next action?

It must not answer by dumping subjects, bodies, full counterparties, or conversations.

## Measuring improvement without paid/live dependence

### Primary operational metric

From canonical `tool_execution_end` events, select native `send_email` failures whose structured error text/code identifies identity capacity. Deduplicate by session and stable tool-call ID. Report:

- affected independent parent sessions;
- capacity failures per affected session;
- whether the next relevant structured action is reuse of an existing address, inspect, restart, stop, cancel, archive, retry, or unresolved cutoff;
- successful recovery episodes in which a later send succeeds after an explicit safe sequence.

Do not claim the supplied “at least five” is the post-change baseline denominator; rerun the same parser on the defined pre-release cohort.

### Safety metrics

From canonical tool and journal objects, report:

- capacity-rejected sends that nevertheless have a created envelope (must be zero);
- successful archive events with a pre-action open blocker (must be zero);
- cancellations lacking actor/reason/inactive-recipient proof in the event sequence (must be zero);
- cancelled requests later marked answered (must be zero);
- recovery episodes ending at dataset cutoff, labeled cutoff rather than failure.

### Privacy and cost

Use already-produced organic session artifacts for observational cohorts and deterministic scripted-provider CI for release acceptance. Do not create paid calls merely to measure behavior. Aggregate in memory; do not export message bodies, subjects, or address lists. Stable session/tool-call/request IDs may be used transiently for deduplication/correlation and then discarded. Do not hash them.

## Compatibility and migration impact

- `BrokerSnapshot` and `AgentInspection` gain additive derived fields.
- Existing `capacityAvailable`, mailbox fields, lifecycle states, tool names, schemas, and action enums remain.
- Visible error/result strings become more detailed; exact-string fixtures require updates.
- `/agents` header/Profile/widget text changes but navigation and actions remain.
- No registry version change, journal event, mail schema, or session migration is planned.
- `maxAgents`/`maxConcurrent` configuration names, defaults, ranges, and semantics remain.
- Archived restoration and persistent identity behavior remain unchanged.
- Downstream subagents gain guidance, not lifecycle authority.

## Risks and races

### Parallel final-slot allocation

Two unknown addresses can attempt the last lease nearly simultaneously. Preserve the current synchronous lease check/acquisition before the first acceptance await, and retain rollback if pre-accept validation fails. Add a final-slot parallel test rather than assuming JavaScript scheduling is sufficient.

### Archive versus new send to the same address

Both use the broker's address-operation serialization. Preserve that boundary so archive cannot release a lease while new queued mail for that identity is being accepted.

### Cancellation versus reply reservation

The mail store already serializes the authoritative transition. Diagnostics must never pre-classify a request as cancellable with certainty; they may identify it as an open blocker and state that `cancel_request` performs final validation.

### Stop versus late worker activity

Stop must complete bounded abort/dispose and settle broker state before archive. A cleanup warning does not mean the lease was released. The result must report actual post-action inspection rather than predicted state.

### Snapshot staleness

Capacity can change between inspection and action. Treat inspection as a current snapshot; every send/restart/archive/cancel operation must revalidate atomically and return an actionable native error on change.

### Overflow identities after config reduction

There can be more persisted records than `maxAgents`. Header wording must show activation leases used/limit, not naïvely `agents.length/maxAgents`. Exact Profile state/lease status prevents an overflow `paused` record from being mistaken for a lease holder or completed work.

### Archived restoration under full capacity

An archived address exists but has no lease. Binary `exists` is insufficient; `holdsActivationLease` and `capacityAvailable` must make restoration constraints clear.

### Privacy leakage

A helpful global candidate list in a subagent error could reveal unrelated agent identities or task subjects. Reject that design. Limit errors to aggregate capacity and safe actions. Existing selected-agent Inbox remains the deliberate operator surface for sensitive mail detail.

### Diagnostic length

Large obligation sets can overflow tool/context/UI bounds. Cap IDs per category, include omitted counts, and never repeat full blocker detail in the widget/header.

### Coordinator chooses destructive recovery

Prompt/result copy must lead with reuse/restart/finish real work. Cancellation requires explicit user abandonment, and archive continues to refuse blockers. Capacity pressure alone never authorizes either destructive semantic decision.

## Rollout

1. Land characterization tests for cap, concurrency, stop, archive, and cancellation.
2. Add derived capacity/blocker data and focused integration tests.
3. Enrich broker/tool/prompt diagnostics.
4. Enrich the existing dashboard header and Profile tab.
5. Add deterministic explicit-action RPC acceptance.
6. Update existing documentation and cross-links.
7. Run all deterministic gates with preserved first-run artifacts.
8. Release without a feature flag because behavior remains fail-closed and fields are additive.
9. Compare canonical pre/post organic cohorts without generating paid traffic.
10. Reassess defaults or larger architecture only through a separate evidence-backed plan.

## Rejected overengineering

### Blindly raise `maxAgents`

Rejected because it increases persistent identities, sessions, provider state, mailboxes, and coordination cost without fixing visibility or obligation recovery. Operators can already configure a justified higher value up to the validated maximum.

### Equate `maxConcurrent` with capacity

Rejected because run slots and identity leases solve different problems. Making them one value would either delete persistent identity semantics or allow uncontrolled execution.

### Auto-stop idle/running agents

Rejected because stop can interrupt work and does not free an activation lease anyway.

### Auto-archive idle, old, or least-recently-used agents

Rejected because age/idle state does not prove absence of substantive context or obligations. Archive must remain an explicit main/operator decision after canonical blocker validation.

### Auto-cancel open obligations

Rejected categorically. Capacity pressure is not user abandonment, cancellation is not completion, and exact actor/reason auditing is a safety invariant.

### Auto-redelegate obligations from inactive agents

Rejected because it can duplicate side effects, loses task-specific recovery policy, and creates more identity pressure. Existing coordinator guidance permits at most one justified recovery attempt.

### Delete identities or sessions to free capacity

Rejected because archive already frees the lease while preserving context and mail safely.

### New `capacity_manager` or bulk-recovery tool

Rejected because `inspect_agent`, `/agents`, `manage_agent`, and `cancel_request` already expose the necessary explicit operations. A compound tool would hide intermediate validation and auditing.

### Global candidate ranking

Rejected in the initial release. “Relevant to this task” is semantic and cannot be inferred safely from age, role label, or subjects. The existing dashboard lets main/operator inspect identities deliberately.

### Put agent addresses/subjects in send errors

Rejected for privacy, context size, and poor relevance—especially when the caller is a downstream subagent. Aggregate counts and a main-directed recovery path are sufficient.

### Persist a capacity or obligation cache

Rejected because activation sets, configuration, and canonical mail envelopes already provide current truth. Another durable cache would need migration and race reconciliation.

### New Capacity dashboard tab/modal

Rejected initially. The existing header, Profile/Lifecycle, Inbox, and lifecycle keys can show the required facts with less UI and test surface.

### Use hashes for privacy-preserving metrics

Rejected. Aggregation can correlate stable IDs transiently and discard them without exporting identifiers; no hash function is needed.

## Expected implementation file set

Production/types/UI:

- `src/types.ts`
- `src/broker.ts`
- `src/main-tools.ts`
- `src/prompts.ts`
- `src/ui.ts`
- `src/sdk-worker.ts` only if compact send-tool prompt guidance is needed

Tests:

- `test/integration/broker.test.ts`
- `test/integration/hardening.test.ts`
- `test/integration/parallel-spawn.test.ts`
- `test/integration/main-tools.test.ts`
- `test/integration/tools.test.ts`
- `test/unit/prompts.test.ts`
- `test/unit/ui.test.ts`
- `test/e2e/helpers/mock-provider-extension.ts`
- `test/e2e/real-flow.test.ts`

Documentation:

- `docs/configuration.md`
- `docs/send-email.md`
- `docs/inspect-agent.md`
- `docs/manage-agent.md`
- `docs/cancel-request.md`
- `docs/agents-dashboard.md`
- `README.md`

Files not expected for the smallest design:

- `src/mail-store.ts`
- `src/registry-store.ts`
- `src/model-runtime.ts`
- any new orchestration subsystem, durable capacity journal, or migration file
