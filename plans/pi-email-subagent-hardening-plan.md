# pi-email-subagent Reliability Plan

## Purpose

Fix the material correctness and reliability issues found by three independent reviews without turning the email broker into a security or distributed-systems platform.

The subagent system exists to maximize outcomes through persistent context, autonomous delegation, independent opinions, and parallel work. Workers are trusted collaborators operating inside an externally secured Pi environment.

The existing 38 passing tests are the baseline. Every in-scope defect receives a failing regression test before its implementation change.

## Implementation result

Completed on 2026-07-24:

- `npm run validate`: 79 tests passed, 0 failed, including real Pi RPC loading.
- Live-provider acceptance passed with `openai-codex/gpt-5.6-terra` main, `kimi-coding/k3` worker, exact reply settlement, and grouped `wait_for_replies` collection without a separate injected email turn.
- Package dry run passed and `npm audit --omit=dev` reports 0 production vulnerabilities.
- A final independent read-only follow-up verified all six late reliability findings were resolved and found no remaining material correctness blocker.
- Manual `/reload-runtime` remains required on Pi 0.81.1, as explicitly accepted below.

## Design assumptions

### Trusted-agent model

This plugin assumes another layer handles:

- filesystem/process sandboxing,
- credential isolation,
- workspace and network policy,
- model/provider authorization,
- malicious same-UID processes,
- organizational access control.

Within the broker:

- authenticated agent identities are trusted collaborators,
- any agent may delegate genuinely independent work,
- unknown valid recipients may still spawn,
- high-priority steering remains available,
- workers may share the project workspace,
- sender binding and exact reply matching prevent accidental identity/reply confusion, not hostile-agent privilege escalation.

The plugin must document these assumptions clearly, but it must not implement capability tokens, privilege lattices, containers, path sandboxes, or main-only spawning.

### Delivery model

- Mail acceptance is durable against ordinary process crashes.
- Reply obligations close only after successful reply delivery.
- Transport delivery is **at least once** across a crash boundary.
- Every email retains a stable ID so recipients can recognize duplicates.
- Exactly-once external side effects are not promised.

### Compatibility model

- Support the tested Pi `0.81.x` SDK line initially.
- Runtime/provider/catalog changes take effect on extension reload; continuous hot synchronization is not required.
- A worker must either inherit enough effective provider state to run or fail early with a precise diagnostic.

## Scope

### In scope

1. Init/shutdown and restart/send races.
2. Concurrent and failed-delivery reply correctness.
3. Prompt preflight hangs and clear at-least-once delivery behavior.
4. Cross-agent priority, queue bounds, rate fairness, and `maxAgents` preservation.
5. Effective role/tool prompt guidance and worker provider startup fidelity.
6. Persistence corruption handling and injection-resistant mail framing.
7. Main-thread agent inspection, reply joining, lifecycle control, and richer send correlation.
8. Focused deterministic, RPC, and live-provider regression coverage.

### Explicitly out of scope

- Broker ACLs, delegation grants, privilege escalation prevention, or main-only spawning.
- `bwrap`, containers, restricted filesystems, environment scrubbing, or separate worktrees.
- Protection against deliberate journal/registry tampering by a worker or same-UID process.
- Authenticated journals.
- Power-loss `fsync` guarantees.
- Exactly-once model/tool execution.
- Comprehensive cost accounting, billing policy, or long-term journal retention.
- Continuous parent/worker runtime synchronization.
- Broad cross-major Pi compatibility.

## Finding disposition

| Review finding | Disposition |
|---|---|
| Init/shutdown leaks late workers | Fix in Workstream A |
| Restart/send creates duplicate workers | Fix in Workstream A |
| Concurrent replies both close one request | Fix in Workstream B |
| Failed reply delivery erases obligation | Fix in Workstream B |
| Prompt preflight false can hang | Fix in Workstream C |
| Crash can redeliver accepted mail | Document at-least-once; preserve stable ID in Workstream C |
| Global scheduling ignores high priority | Fix in Workstream D |
| Lower `maxAgents` deletes identities | Fix in Workstream D |
| Invalid sends consume shared quota | Fix in Workstream D |
| Unbounded queued batch can break context | Add simple count/byte limits in Workstream D |
| Prompt role guidance contradicts config | Fix in Workstream E |
| Worker runtime is a partial parent snapshot | Improve startup snapshot/fail-fast in Workstream E |
| Wildcard Pi peer contract | Narrow to tested range in Workstream E |
| Hardcoded `.pi` config path | Use `CONFIG_DIR_NAME` in Workstream E |
| Unknown/malformed persistence events | Validate as corruption in Workstream F |
| Plaintext fetched mail/alerts permit framing confusion | Fix as protocol robustness in Workstream F |
| No pre-send visibility into effective role/tools/state | Add `inspect_agent` in Workstream G |
| No join/collection primitive for delegated requests | Add `wait_for_replies` in Workstream G |
| No model-facing stop/restart/archive control | Add `manage_agent` in Workstream G |
| Completed replies arrive as fragmented follow-up turns | Add correlated collection mode in Workstream G |
| Failed/completed identities permanently consume capacity | Add safe archival in Workstreams D/G |
| `send_email` omits expected reply subject/profile details | Enrich result in Workstream G |
| Extension changes require awkward manual reload | Document and request upstream deferred-command API in Workstream G |
| Missing ACL/capability authorization | External security layer; document only |
| Missing filesystem/process isolation | External security layer; document only |
| Malicious persisted-state forgery | External security layer; validate corruption but do not add tamper resistance |
| Missing power-loss fsync | Accepted limitation; document process-crash durability |

---

## Workstream A — Cancellation-safe lifecycle

### Objective

Ensure a broker owns exactly one worker per address and cannot create, publish, or persist workers after shutdown.

### Implementation

Introduce an explicit lifecycle:

```text
new -> initializing -> active -> closing -> closed
```

Add:

- a broker-level cancellation/generation token,
- one `initPromise`,
- tracked in-flight worker creations,
- a per-address async mutex/singleflight for `ensureWorker`, `restart`, and `stop`,
- one idempotent `closePromise` returned by every shutdown call.

`AgentBroker.init()` must check cancellation after store loading, registry loading, and each restored-worker await. A worker created after cancellation must be disposed immediately and never committed to broker maps.

`createWorker()` should construct provisionally, then commit the worker/subscription only if the broker remains active.

`shutdown()` must:

1. transition to `closing`,
2. cancel initialization and new scheduling,
3. await or cancel all spawn/restart operations,
4. dispose all committed and provisional workers,
5. persist the final registry state,
6. flush stores,
7. transition to `closed`.

`SdkWorker.start()` must check its own disposed/start generation after every await and dispose a partially created `AgentSession` if disposal wins.

Concurrent `restart(address)` and `send()` must join one address lifecycle operation. They may not produce two transports or subscriptions.

### Tests first

Add deterministic barriers rather than timing-only sleeps:

1. delayed broker init raced with shutdown,
2. delayed worker start raced with shutdown,
3. shutdown while several restored workers are at different start phases,
4. restart raced with send while old-worker disposal is blocked,
5. repeated shutdown calls,
6. late worker events after close,
7. no registry writes/publications after close,
8. exactly one worker, subscription, and prompt after restart/send race.

### Acceptance

- Shutdown does not resolve while owned work can still create a worker.
- No old runtime delivers mail or writes state after replacement.
- One address has at most one live worker and subscription.
- Reload/new/resume/fork lifecycle E2E tests leave no leaked sessions.

---

## Workstream B — Atomic reply obligations

### Objective

Allow only one reply to claim a request and close the obligation only after that reply is delivered.

### Implementation

Move reply check-and-claim into `MailStore`’s serialized write chain.

Use a small obligation state:

```text
open -> reserved -> answered
reserved -> open on terminal reply delivery failure
```

Replace `accept(email, answersId?)` with operations similar to:

```ts
reserveReply(reply, originalId): Promise<void>
commitReply(replyId, originalId): Promise<void>
releaseReply(replyId, originalId, error): Promise<void>
```

`reserveReply` atomically checks that the original exists, is delivered, requires a response, and is neither reserved nor answered.

Delivery flow:

1. persist reply plus reservation,
2. route reply,
3. when delivery succeeds, persist reply delivery and obligation answer together,
4. when delivery fails terminally, mark reply failed and release reservation.

A queued reply keeps the original reserved rather than answered. Mailbox enforcement must not issue duplicate reminders while a valid reservation exists. UI may show the answer as pending.

Journal replay must reconstruct open/reserved/answered state and reconcile a reservation with its reply’s queued/delivered/failed state.

### Tests first

1. `Promise.allSettled` for two exact concurrent replies: one success, one rejection.
2. Same case after journal reload.
3. Main delivery failure reopens the original.
4. Worker delivery failure reopens the original.
5. Reply queued to a stopped recipient remains reserved, not answered.
6. Restart at each reservation/delivery/commit/release boundary.
7. No enforcement reminder during a pending valid reply.
8. Replayed transition events are idempotent.

### Acceptance

- At most one reply reserves an obligation.
- An undelivered reply never permanently closes a request.
- Restart reconstructs the same obligation state.
- A later valid reply can succeed after terminal delivery failure.

---

## Workstream C — Reliable prompt acceptance and explicit at-least-once delivery

### Objective

Prevent scheduling hangs and make duplicate-delivery behavior simple and honest.

### Implementation

Fix `SdkWorker.prompt()` so every preflight outcome settles its wrapper:

- `success=true` resolves acceptance,
- `success=false` rejects immediately with an actionable error,
- underlying rejection propagates,
- normal completion without accepted preflight rejects instead of hanging.

Preserve email IDs in every delivered envelope and batch. Strengthen the worker prompt:

- process each stable email ID once when possible,
- if the same ID is observed again after recovery, treat it as a retry and do not repeat completed side effects,
- include the ID in replies and diagnostics.

Do not add a complex exactly-once transaction spanning the broker, model, and tools. Document the crash window between worker acceptance and broker delivery marking as at-least-once.

Optionally add a lightweight session-local accepted-ID marker only if it can use existing durable `AgentSession` entries without a second persistence subsystem. This optimization must remain small and must not block the core fix.

High-priority steer and normal prompt delivery must report acceptance/failure consistently.

### Tests first

1. preflight false then resolved underlying promise rejects promptly,
2. preflight rejection releases the broker scheduling slot,
3. underlying prompt error preserves the provider error,
4. replay after simulated crash retains the same email ID,
5. duplicate-ID prompt guidance is present,
6. high-priority and low-priority paths expose consistent acceptance results.

### Acceptance

- No prompt preflight outcome can leave a pending promise or occupied slot forever.
- Provider errors reach main without misleading mailbox enforcement.
- At-least-once semantics and the duplicate-ID contract are documented.

---

## Workstream D — Priority, capacity, and queue bounds

### Objective

Let autonomous agents continue delegating while preventing one busy agent or queue from degrading the entire system.

### Implementation

Replace FIFO `pendingStarts` selection with a small priority-aware scheduler:

1. high-priority pending mail first,
2. then oldest mail timestamp,
3. then stable address order.

Promote an already pending address when high-priority mail arrives. Add simple aging so continuous high traffic cannot starve low work indefinitely.

Validate address, authorization-independent protocol rules, reply metadata, sizes, recipient capacity, and subject/body requirements before consuming rate quota.

Use bounded controls only:

- existing maximum registered agents,
- existing maximum concurrent agents,
- per-message subject/body limits,
- global plus per-sender mail rate limit,
- maximum queued messages and aggregate queued bytes per recipient/session,
- maximum batch messages and bytes,
- optional worker wall-clock timeout.

Do not add cost ledgers, capability budgets, or elaborate retention policy in this workstream.

When loading a registry with more records than current `maxAgents`, retain every identity and its mail. Apply the cap to new registrations and active restoration; mark overflow identities paused with an explanation.

Distinguish retained identities from identities that count against active registration capacity. A safely archived identity remains durable but does not consume an active slot; it can be restored with its original context when capacity is available.

Stopped/failed recipients should apply clear backpressure once their bounded queue is full.

### Tests first

1. occupied slot + low A + high B starts B first,
2. aging eventually schedules low work,
3. high mail promotes an existing pending address,
4. invalid mail does not consume another sender’s quota,
5. one sender hitting its rate limit does not block another,
6. queue message/byte cap,
7. batch count/byte cap,
8. stopped-recipient backpressure,
9. lowering `maxAgents` preserves all durable records and mail,
10. no new over-cap identity is accepted.

### Acceptance

- High priority matters across agents.
- Independent agents retain fair progress.
- Queues and prompt batches are bounded.
- Capacity changes never delete durable identities.

---

## Workstream E — Effective configuration and provider startup fidelity

### Objective

Ensure the main prompt describes actual configured roles and workers start with the same effective provider behavior expected by main.

### Implementation

Generate a compact role/tool summary from effective `SubagentConfig` after global and trusted-project overlays. Pass it into `mainCoordinatorPrompt`.

The prompt must:

- distinguish defaults from effective runtime facts,
- show which configured roles are writable or read-only,
- avoid claiming that a role has tools it no longer has,
- continue encouraging agents to choose a role capable of the requested work.

Keep this as outcome guidance, not broker privilege enforcement.

Create a focused `WorkerRuntimeFactory` responsible for startup snapshot behavior:

- create the worker `ModelRuntime`,
- copy current registered custom/native provider definitions,
- use the same persistent credential sources,
- resolve the selected model against the current catalog,
- check provider authentication before accepting first delivery,
- return a precise error when runtime-only auth cannot be transferred.

Do not continuously synchronize after worker creation. Provider/model/config changes require extension reload; document this.

On parent model selection, update main aliases as today. New worker model availability is refreshed on the next extension reload.

Configuration and packaging:

- use Pi’s `CONFIG_DIR_NAME` rather than hardcoded `.pi`,
- change Pi peer dependencies from `"*"` to a tested `>=0.81.1 <0.82.0` range unless broader versions are actually validated,
- keep version-sensitive SDK calls localized in the runtime/worker adapter,
- test extension load and worker lifecycle on the minimum and latest `0.81.x` releases available in CI.

### Tests first

1. overridden `worker`, `scout`, and `reviewer` tools appear correctly in prompts,
2. exact-address tool overrides appear correctly,
3. custom and native provider definitions transfer at worker startup,
4. persistent OAuth/API-key auth works in a real worker request,
5. runtime-only auth fails before mail delivery with an actionable message if unsupported,
6. provider model missing from worker snapshot fails clearly,
7. rebranded `CONFIG_DIR_NAME` project config discovery,
8. minimum/latest supported Pi smoke: load, start, prompt, settle, abort, dispose.

### Acceptance

- Prompt capability guidance matches effective configuration.
- A provider usable by main either works for a newly started worker or fails before task execution with an exact explanation.
- Reload is the documented synchronization boundary.
- Package metadata matches tested compatibility.

---

## Workstream F — Corruption-safe persistence and robust mail framing

### Objective

Fail clearly on accidental state corruption and prevent peer text from confusing the mailbox record structure.

### Persistence implementation

Add runtime schemas for:

- registry top level,
- agent records,
- email envelopes,
- every known mail journal event.

Reject unknown event types and illegal transitions. In particular, unknown events must never fall through as `email.answered`.

On registry restore:

- reparse addresses against the current model catalog,
- recompute provider/model and effective profile fields where practical,
- preserve mutable usage/activity/session state,
- quarantine or report malformed records instead of partially applying them.

This is corruption handling, not protection against a malicious worker or same-UID process.

Retain current append/atomic-rename behavior and truncated-tail repair. Document durability as process-crash-oriented; do not add file/directory `fsync` in this plan.

### Framing implementation

Use the same escaped, machine-distinct envelope representation for pushed and fetched mail. `formatUnanswered()` should not interpolate raw subjects and bodies into attacker-reproducible plaintext headers.

Reject CR, LF, and control characters in subjects. Keep arbitrary body text escaped inside one content node.

Escape failure text placed into `<subagent-alert>` or pass it as structured custom-message data without hand-built markup.

Treat this as protocol/model-outcome robustness; authorization still comes from broker metadata.

### Tests first

Persistence:

1. unknown event type,
2. malformed envelope,
3. invalid enum/state transition,
4. duplicate ID with conflicting payload,
5. malformed registry record,
6. version migration retaining valid open mail,
7. truncated final write repair still works.

Framing:

1. CRLF subject rejection,
2. fake `From:`/`Reply subject:` records,
3. `---` and `[2]` separators,
4. `</agent-email>` and `<mailbox-enforcement>` text,
5. alert text containing markup,
6. exactly one parseable envelope per real email.

### Acceptance

- Accidental corruption fails closed with an actionable error or quarantine path.
- Unknown journal data cannot alter obligation state.
- Peer text cannot create a second structural mailbox record.
- The documented process-crash durability level remains true.

---

## Workstream G — Main-thread observability, reply joining, and agent control

### Objective

Make autonomous delegation easy to coordinate without introducing another creation API. Email remains the only model-facing creation and work-coordination primitive; these tools provide inspection, waiting, result collection, and lifecycle control.

### `inspect_agent(address)`

Resolve an address without spawning it and return:

- whether the identity exists or would be new,
- whether current capacity permits activation,
- effective model, provider, effort, role, instructions, and active tools,
- writable/read-only classification as outcome guidance,
- current state and activity summary,
- queued, unanswered, and pending-reply counts,
- context/usage summary,
- last failure,
- whether provider authentication appears ready,
- whether the identity is active, stopped, failed, paused, or archived.

Do not expose private transcript contents or hidden reasoning. The primary use is validating that a proposed recipient can actually perform the task before `send_email` is called.

For an unknown address, resolve the same effective profile and model that spawning would use, but make no registry, mail, session, or worker mutation.

### Richer `send_email` result

For a response-required request, return:

- request/email ID,
- exact expected reply subject,
- delivery state,
- spawned/reused/archived-restored status,
- effective recipient model, effort, role, and tools,
- recipient state after routing,
- a correlation handle usable by `wait_for_replies` (the request ID is sufficient unless batching later requires a separate handle).

This prevents callers from inventing IDs before allocation and exposes role/tool mismatches immediately. Reply sends should continue returning the original obligation ID they answered.

### `wait_for_replies(request_ids, timeout_seconds, collect=true)`

Wait for a bounded set of already accepted request IDs until each is:

- answered,
- failed,
- stopped/archived with no deliverable result, or
- still pending when the timeout expires.

Requirements:

- maximum request count and timeout are bounded,
- existing terminal results return immediately,
- an abort signal removes all subscriptions/timers,
- multiple waiters may observe the same durable result,
- timeout returns a structured partial result rather than throwing away completed replies,
- failure returns the original provider/broker error,
- results preserve request order and include reply envelope/message where available.

With `collect=true`, replies correlated to the waiter should be persisted and rendered for observability without triggering separate model turns. The waiter returns them together in one tool result. With no waiter, normal low/high main delivery behavior remains unchanged.

Implement collection as a broker/main-adapter subscription, not polling of JSON files. If Pi cannot display a captured reply without triggering a turn, prefer one grouped custom message after collection rather than one turn per reply.

### `manage_agent(address, action)`

Expose main-thread-only controls:

- `stop`,
- `restart`,
- `archive`,
- `clear_failure`.

Workers continue receiving only `send_email` and `fetch_emails`; they cannot invoke this control tool.

Archive semantics:

1. reject archive while the agent is running,
2. reject archive when queued mail, unanswered requests, or pending replies exist,
3. stop/dispose the transport and subscriptions,
4. retain the registry record, session file, usage, and mail,
5. mark the identity `archived`,
6. exclude it from active `maxAgents` capacity,
7. allow explicit restart or a later send to restore the same persistent context when capacity permits.

`clear_failure` removes stale diagnostics only while idle/stopped/archived; it does not fabricate task success or discard mail.

Keep `/agents` TUI commands as aliases over the same broker methods so model-facing and user-facing controls cannot diverge.

### Operational guidance

Update coordinator prompts and tool descriptions to require:

- call `inspect_agent` when recipient capability is uncertain,
- use effective configured tools rather than role labels such as “implementer” or “copywriter”,
- never invent a mail ID or expected reply subject,
- use one primary agent and reuse its address for continuing work,
- use `wait_for_replies` instead of polling registry files or repeatedly calling status tools,
- use archive rather than creating unlimited replacement identities,
- preserve the bounded one-recovery-attempt policy.

### Pi reload dependency

Do not recreate the broken extension-originated `/reload-runtime` follow-up loop. Continue documenting one manual `/reload-runtime` after extension changes on Pi 0.81.1.

Open an upstream Pi request for a safe deferred command API such as `ctx.deferCommand()`/`executeCommandAfterTurn()`. If Pi supplies it in a supported release, adapt the reloader there; it is not part of this plugin’s broker protocol.

### Tests first

1. `inspect_agent` previews an unknown address without spawning or persisting anything.
2. Previewed role/tools/model exactly match the subsequently spawned worker.
3. Inspection reports existing state, counts, usage, failure, archive, and provider readiness.
4. `send_email` returns the allocated request ID, exact expected reply subject, and effective recipient profile.
5. Two or three parallel requests complete through one `wait_for_replies` result in request order.
6. Wait returns mixed answered/failed/pending results on timeout.
7. Wait abort cleans up listeners and timers.
8. Collection suppresses redundant model turns while retaining durable/rendered replies.
9. Stop/restart behavior matches `/agents` controls.
10. Archive rejects live or obligated agents and succeeds for a clean idle/stopped agent.
11. Archived identity frees capacity and later restores the same session/context.
12. `clear_failure` cannot clear active work or alter mail obligations.
13. Worker tool lists never include inspection/wait/control tools.
14. Tool rendering remains width-safe and clearly distinguishes preview, waiting, collected, and archived states.

### Acceptance

- Main can determine recipient capability before delegation without side effects.
- Main can join several independent reviews/tasks without filesystem polling.
- Correlated replies can be returned as one grouped result rather than fragmented turns.
- Old clean identities can be archived to free capacity without losing context.
- Email remains the sole mechanism that creates agents or assigns work.
- No control tool is available inside worker sessions.

---

## Implementation sequence

### Milestone 0 — Invariants and deterministic race harness

1. Record the trusted-agent, external-security, at-least-once, and reload-boundary assumptions in design docs.
2. Add barriers/fault injection to fake workers, stores, adapters, and main delivery.
3. Add resource-leak assertions for workers and subscriptions.

### Milestone 1 — Core correctness

1. Workstream A lifecycle.
2. Workstream B reply obligations.
3. Workstream C preflight settlement.

These are P0 because they can leak workers or lose response obligations.

### Milestone 2 — Autonomous scheduling and bounded operation

1. Workstream D priority scheduler.
2. Capacity preservation and queue/batch limits.
3. Per-sender rate fairness.
4. Archive state and capacity accounting needed by Workstream G.

### Milestone 3 — Runtime/config fidelity

1. Effective prompt role summary.
2. Worker runtime startup factory and fail-fast auth.
3. `CONFIG_DIR_NAME` and peer range.
4. Shared profile/status projection used by `inspect_agent`.

### Milestone 4 — Main coordination tooling

1. Enrich `send_email` correlation/profile results.
2. Add side-effect-free `inspect_agent`.
3. Add event-driven `wait_for_replies` and grouped collection.
4. Add `manage_agent` and `/agents` method reuse.
5. Add archive/restore lifecycle tests.

### Milestone 5 — Persistence and framing robustness

1. Runtime schemas and exhaustive journal replay.
2. Version migration/corruption diagnostics.
3. Unified escaped mailbox/alert framing.

### Milestone 6 — End-to-end release validation

1. Run deterministic tests repeatedly and under test concurrency.
2. Run real Pi RPC lifecycle tests for reload/new/resume/fork.
3. Run live OpenAI and Kimi delegation/reply tests.
4. Test two or more independent agents running concurrently with high/low mail.
5. Test agent-to-agent delegation remains functional within limits.
6. Package dry run and production dependency audit.
7. Update README, protocol, configuration examples, E2E plan, and known limitations.
8. Request one final independent read-only reliability review.

## Suggested test files

```text
test/integration/lifecycle-races.test.ts
test/integration/reply-transaction.test.ts
test/integration/priority-limits.test.ts
test/integration/runtime-startup.test.ts
test/integration/agent-coordination-tools.test.ts
test/integration/reply-collection.test.ts
test/unit/mail-state-machine.test.ts
test/unit/persistence-schema.test.ts
test/unit/mail-framing.test.ts
test/unit/effective-role-prompt.test.ts
test/e2e/session-replacement.test.ts
```

Concurrency tests must use explicit barriers, not arbitrary sleep timing.

## Release gates

- [x] Shutdown cannot complete before late worker creation is cancelled/drained.
- [x] Restart/send produces one worker and one subscription.
- [x] Concurrent replies produce one reservation and one answer.
- [x] Failed reply delivery cannot close the original obligation.
- [x] Prompt preflight rejection cannot hang a slot.
- [x] At-least-once and stable-ID behavior is documented and tested.
- [x] High priority is honored across queued agents with starvation protection.
- [x] Queue and batch sizes are bounded.
- [x] Lowering `maxAgents` preserves identities and mail.
- [x] `inspect_agent` previews the exact effective recipient profile without side effects.
- [x] `send_email` returns an allocated correlation ID and exact expected reply subject.
- [x] `wait_for_replies` joins mixed results without polling or fragmented model turns.
- [x] Stop/restart/archive/clear-failure controls preserve mail and context invariants.
- [x] Archived clean identities free capacity and restore their persistent context.
- [x] Workers cannot access main-only inspection/wait/control tools.
- [x] Effective prompt role guidance matches configuration overrides.
- [x] Worker provider/auth startup succeeds or fails before execution with a clear reason.
- [x] Unknown persistence events and malformed records fail clearly.
- [x] Fetched/pushed mail and alerts cannot be structurally confused by peer text.
- [x] Agent-to-agent delegation and independent parallel work remain functional.
- [x] All deterministic, RPC, live-provider, compatibility, and packaging checks pass.

## Accepted limitations

The release documentation must state:

- Workers are trusted and may delegate to other agents.
- Host security, credential isolation, path restrictions, and workspace isolation are external responsibilities.
- Shared writable workspaces can produce semantic conflicts.
- Delivery is at least once across crashes; stable email IDs support deduplication.
- Durability targets ordinary process crashes, not sudden power loss.
- Provider/catalog changes require extension reload.
- On Pi 0.81.1, runtime reload remains a manual user command until Pi exposes a safe deferred-command API.
- Pi compatibility is limited to the declared and tested SDK range.
