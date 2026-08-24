# Remaining Open Problems — Release-Readiness Plan

Date: 2026-08-23
Status: proposed — implementation not started
Baseline: `770da60d99278e45cf691698a0edbe62a84e9ed8`
Release posture: **no-go until every P1 gate below is closed or explicitly moved behind a safe disabled-by-default boundary**

## Purpose

This document is the single overview and execution order for problems that remain after implementing the six systematic-issue plans and applying the lifecycle, persistence, packaging, RPC, and Linux hardening follow-ups.

It does not reopen work already completed. It consolidates only current defects, incomplete guarantees, and upstream dependencies confirmed by the final independent reviews of baseline `770da60`.

The current deterministic suite is green, package policy passes, and the branch is pushed and clean. Those facts do not override the release-blocking sequences below; several branches have no regression yet.

## Completed work that is not part of this plan

The following implementations remain accepted unless a new failing test proves a regression:

- active-tool-aware idle handling for exact tool start/end IDs while keeping the absolute run deadline;
- exact-worker/generation settlement ownership and cleanup-release visibility;
- cleanup quarantine, persisted capability/run-slot reconstruction, and explicit late recovery;
- truthful acceptance and resumption of mail deferred by cleanup quarantine;
- Linux owner-generation fencing against stealing a stale-mtime lease from a live stopped owner;
- abandoned-owner quarantine for the currently covered active/restorable states;
- timed-out `wait_for_replies` guidance and ordinary late delivery;
- identity-capacity versus run-slot visibility and explicit recovery controls;
- Pi-owned provider retry characterization and provider-aware model binding;
- atomic mail-tail repair, strict RPC framing, supported `SessionManager` UI usage, namespace mode repair, and package policy;
- load-safe Pi feature checks for the currently enumerated surface.

## Non-negotiable invariants

Every phase must preserve these properties:

1. A durably accepted mail ID is never represented as unaccepted and is never silently replayed as a new obligation.
2. One substantive result answers only the request it actually satisfies.
3. Provider or lifecycle recovery never duplicates possible side effects without an explicit operator decision.
4. Failed, stopped, quarantined, archived, and idle are distinct lifecycle facts.
5. Mail answer, reply reservation, cancellation, and presentation transitions remain crash-aware and exact-ID correlated.
6. Idle liveness and the absolute run deadline remain separate.
7. Worker settings and credentials cannot silently change the main session or select another account.
8. Registry/UI/prompts contain only bounded, sanitized summaries; detailed provider/session evidence remains in the protected worker session.
9. Runtime capability claims come from activated tools and supported Pi APIs, not configured intent or role labels.
10. Unknown process quiescence remains fail-closed.
11. No count or rate is derived by grepping structured session, RPC, registry, or journal artifacts.
12. No automatic cancellation, obligation deletion, provider failover, or cross-provider identity rebind is introduced.

## Priority overview

| Priority | Cluster | Release decision |
|---|---|---|
| P1 | Mail completion, failed-recipient recovery, and nested delegation | Block release |
| P1 | Collected-reply crash presentation | Block automatic-presentation guarantee |
| P1 | Worker-local settings and model-option isolation | Block worker startup/effort release |
| P1 | Credential/account equivalence | Block providers with runtime auth overrides |
| P1 | Bounded provider/session errors | Block external-provider release |
| P1 | Abrupt-owner recovery for failed writable records | Block writable crash recovery |
| P1 external | Pi process/tool quiescence receipt | Block generic writable cleanup guarantee |
| P2 | Model-stream and retry-backoff liveness | Fix before short-idle policies are supported |
| P2 | Hung-abort disposal progression | Fix before bounded cleanup is claimed complete |
| P2 | Runtime active-tool truth | Fix before capability-based authorization claims |
| P2 | Orphan mutation evidence | Fix before work-ledger recovery claims |
| P2 | Pi compatibility guard depth | Fix before claiming graceful alternate-version failure |
| P3 | Pending-reply count drift and prompt/documentation cleanup | Fix in the same release branch |

## Execution order

Implement the phases sequentially. Later phases rely on lifecycle and protocol semantics established earlier.

1. Mail obligation and recovery semantics.
2. Worker settings and authentication isolation.
3. Liveness, error safety, and runtime capability truth.
4. Abrupt-owner and cleanup completion gaps.
5. Compatibility and operator-surface consistency.
6. Upstream Pi gates and final cross-domain review.

Each phase should land as one or more coherent commits and be pushed after its focused and full gates pass.

---

## Phase 1 — Mail obligation and recovery semantics

### 1.1 Restrict mechanical completion to one attributable request

#### Current problem

`AgentBroker.sendCompletionReplies()` receives every outstanding request and reuses one visible final text. With one sender, it can answer several unrelated IDs with the same body. With several senders, it can commit a generic follow-up notice as a terminal answer.

This violates the substantive-response contract and can permanently close work that was not completed.

#### Target behavior

Mechanical fallback is allowed only when all are true:

- exactly one delivered unanswered inbound request is attributable to the settled worker batch;
- there is no open outgoing dependency from that worker;
- the completion text is nonempty and within existing bounds;
- the exact worker/generation settlement still owns the transition.

Otherwise:

- leave every obligation open;
- enter the existing bounded mailbox-enforcement path;
- never send a generic terminal notice;
- preserve the worker session and exact IDs for explicit recovery.

#### Likely files

- `src/broker.ts`
- `src/mail-store.ts` only if attribution cannot be derived from current envelopes/batches
- `test/integration/broker.test.ts`
- `test/integration/lifecycle-races.test.ts`
- `test/e2e/real-flow.test.ts`
- `docs/send-email.md`
- `docs/lifecycle.md`

#### Required regressions

- two old/new requests from the same sender, only one addressed by final text;
- two requests from different senders;
- one inbound request plus one open outgoing child request;
- settlement racing a new request;
- exactly one unambiguous request still receives the fallback once;
- no generic notice writes `answeredAt`.

### 1.2 Make failed identities require explicit recovery

#### Current problem

`AgentBroker.ensureWorker()` treats `stopped` specially but can recreate a `failed` identity when ordinary mail arrives. This silently performs provider/lifecycle recovery and can repeat effects before the operator inspects Work and Conversation.

#### Target behavior

- Mail to a failed identity is accepted and queued under the same stable identity.
- The result reports a truthful failed/inactive disposition.
- No worker is created until explicit `manage_agent restart` succeeds.
- Replies from child agents do not implicitly restart a failed parent.
- Restart guidance requires effect review and same-identity recovery.

#### Required regressions

- terminal provider failure after one write, then ordinary request;
- terminal failure, then reply to an outgoing request;
- queued mail survives inspection/restart and is delivered once;
- no automatic worker factory invocation before explicit restart.

### 1.3 Disable unsupported nested delegation by default

#### Current problem

Unknown profiles default `canSpawn` to true, but subagents have no durable parent-scoped join. An upstream request can be mechanically completed before the child result arrives, and child terminal failure is not guaranteed to wake the delegating parent as a durable result.

#### Target behavior

Initial safe release:

- unknown/default profiles have `canSpawn: false`;
- configured roles/addresses may opt in explicitly;
- prompts describe opt-in nested delegation as advanced and obligation-preserving.

For opt-in spawning:

- an inbound parent obligation remains open while an outgoing child request is open;
- child reply wakes the parent through ordinary mail;
- child terminal failure produces a durable blocker result to the delegating parent, not only a main alert;
- upstream completion occurs only after the parent sends an exact substantive reply.

Do not add a second orchestration subsystem if existing request/reply mail can express the dependency.

#### Likely files

- `src/config.ts`
- `src/prompts.ts`
- `src/broker.ts`
- `test/unit/config.test.ts`
- `test/unit/prompts.test.ts`
- `test/integration/broker.test.ts`
- one real nested RPC scenario
- `docs/configuration.md`
- `docs/send-email.md`

### 1.4 Close the collected-reply presentation crash window

#### Current problem

With `collect: true`, a reply can be committed delivered/answered after the collection claim while ordinary main delivery is suppressed. If the process exits before the tool result is durably presented in the main session, the request is already answered and the reply has no automatic restore path.

#### Decision gate

First determine whether the supported Pi extension/tool API exposes a durable tool-result or session-entry acknowledgement at the required boundary.

##### If supported

Add the smallest durable state machine:

1. reply created;
2. collection claim reserved;
3. presentation artifact durably appended/acknowledged;
4. reply marked delivered and request answered;
5. restore replays only committed-but-unpresented replies.

The reply must not appear both in the collected tool result and as a duplicate visible main message.

##### If unsupported

- add a deterministic kill/restart reproducer at the commit-to-tool-result boundary;
- document the exact Pi-core receipt needed;
- narrow the automatic-presentation guarantee;
- do not add a speculative unread cursor or claim exactly-once presentation.

#### Required tests

- crash before presentation acknowledgement;
- crash after acknowledgement but before ordinary settlement;
- collector timeout versus reply commit;
- no collect-plus-custom-message duplication;
- stable reply/request IDs through restore.

---

## Phase 2 — Worker settings and authentication isolation

### 2.1 Use a non-persistent worker settings manager

#### Current problem

`SdkWorker.start()` loads file-backed settings and then calls session setters for steering, follow-up, and effort. In Pi 0.81.1 those setters persist global defaults. Worker creation or `/agents effort` can therefore alter unrelated future/main sessions.

Two real remediation agents also failed with:

```text
prompt_cache_retention is not supported on this model
```

That operational failure is consistent with worker settings forwarding a model/provider option that the selected worker route rejects. The exact causal path must be characterized rather than assumed.

#### Target behavior

- Load and merge effective global/trusted-project settings once through supported Pi APIs.
- Copy only worker-relevant, model-supported values into `SettingsManager.inMemory(...)` or an equivalent no-write storage.
- Apply worker-only steering/follow-up/effort locally.
- `setEffort()` changes only that worker session/record.
- Global and project setting files remain byte-equivalent after start, restart, effort change, cleanup, and failure.
- Model/provider-specific unsupported options fail before mail acceptance or are omitted through supported capability/config APIs; do not hardcode one model string.

#### Required tests

- global/project settings snapshots before and after worker lifecycle;
- trusted versus untrusted project retry/transport values;
- effort changes on two workers do not race global defaults;
- unsupported `prompt_cache_retention` reproduction for `gpt-5.6-sol` route;
- supported models retain valid settings;
- parse/load errors remain bounded and do not leak file contents.

#### Likely files

- `src/sdk-worker.ts`
- `src/types.ts` only if a focused effective-settings snapshot is required
- `test/integration/sdk-worker-start.test.ts`
- real worker restart/effort test
- `docs/configuration.md`
- `docs/provider-retry-recovery.md`

### 2.2 Preserve credential/account equivalence

#### Current problem

`WorkerRuntimeFactory.create()` verifies only that parent auth exists while worker auth is absent. If main uses runtime-only account A and the isolated runtime resolves stored/environment account B, both are truthy and the worker silently uses B.

#### Target behavior

- Inspect Pi's supported provider auth-source status without logging or comparing secret material.
- Parent `runtime` auth fails closed unless Pi provides a secure exact-context transfer API.
- Stored/environment/OAuth sources must resolve compatibly under an explicit policy.
- Diagnostics name only provider and source class, never credentials, labels containing secrets, or tokens.
- Provider/model binding is not treated as credential equivalence.

#### Required matrix

- runtime parent + no worker auth;
- runtime parent + different stored auth;
- stored parent + same stored source;
- environment source agreement and disagreement;
- OAuth stored/refresh path;
- provider registered through native and configured mechanisms.

#### Likely files

- `src/model-runtime.ts`
- `test/unit/model-runtime.test.ts`
- one deterministic real worker startup test
- `docs/configuration.md`
- `README.md`

---

## Phase 3 — Liveness, error safety, and runtime capability truth

### 3.1 Treat model streaming and retry backoff as known in-flight work

#### Current problem

The idle watchdog understands active tools, but not long model token/thinking streams or an `auto_retry_start` delay longer than `idleTimeoutMs`.

#### Target behavior

Introduce one content-free ephemeral lifecycle source for:

- model request/stream start;
- model update heartbeat;
- model/attempt end;
- Pi agent retry backoff start/end.

Rules:

- known model/retry in-flight state disarms or refreshes only idle;
- the absolute run deadline never moves;
- no text, thinking, error payload, token content, or partial provider response crosses the lifecycle event;
- high-frequency updates do not persist registry state or publish UI snapshots;
- a provider below Pi's event surface can still stall and remains bounded by idle/run policy.

#### Required real tests

- spaced model deltas crossing a shortened idle interval;
- continuous thinking deltas with no visible text;
- no-delta provider stall triggers idle;
- retry backoff longer than idle reaches the next attempt;
- model/retry activity longer than run still triggers run timeout;
- stale generation events cannot revive a replacement.

### 3.2 Bound and sanitize provider/session errors once

#### Current problem

Raw assistant/provider errors can flow into Activity, `record.failure`, registry persistence, UI, and main alerts. This can leak signed URLs/header fragments or cause storage/context amplification.

#### Target behavior

Add one ingress helper, for example `safeErrorSummary`, with:

- UTF-8 byte and line bounds;
- terminal-control stripping;
- redaction for common credential-bearing URL/query/header forms without claiming universal secret detection;
- constant fallback when a safe summary cannot be produced;
- no duplicate broker append of the same raw value.

Detailed native error data stays only in the protected worker session/Conversation surface.

Rename visible `auto_retry_*` activity to **Pi agent retry**, and document the difference between:

- provider/SDK internal attempt;
- Pi agent retry;
- accepted worker run;
- delegation;
- durable mail obligation.

#### Required tests

- oversized multibyte error;
- terminal controls;
- signed URL, authorization/header-like sentinel, and embedded mail text;
- retry and terminal paths;
- registry round trip and main alert bounds;
- raw detail remains available only in the native worker session fixture.

### 3.3 Synchronize activated tools

#### Current problem

`SdkWorker` records `session.getActiveToolNames()`, but `AgentBroker.syncWorker()` does not copy that runtime set. Inspection, send results, writable classification, and quarantine decisions can therefore reflect configured intent rather than actual active tools.

#### Target behavior

- Preserve configured tool intent only if needed for diagnostics.
- Store/synchronize actual active tools separately or make the existing runtime-facing field authoritative after startup.
- Authorization and writable/quarantine classification use actual active tools when a live worker exists.
- Prospective inspection clearly labels configured intent.
- Unknown tools omitted by Pi are visible as a bounded diagnostic, not advertised as usable.

### 3.4 Preserve orphan mutation evidence conservatively

#### Current problem

An orphan `edit`/`write` result with no correlated start/path can be represented as failed or skipped. Either outcome can encourage unsafe replay of a mutation whose effects are unknown.

#### Target behavior

Represent it as a bounded unverified/unknown-effect work item containing only:

- stable tool-call ID;
- tool name;
- observed terminal success/error flag;
- timestamp/batch when known;
- explicit missing-intent/path diagnostic.

It must never enter confirmed file aggregates and must survive registry/session recovery consistently.

### 3.5 Ensure disposal progresses when abort never settles

#### Current problem

The authoritative cleanup promise now observes late abort, but if `session.abort()` never settles, `session.dispose()` is never attempted.

#### Target behavior

- Keep the authoritative cleanup report pending for late abort.
- At the abort response deadline, invoke `dispose()` exactly once independently.
- Continue observing abort settlement.
- Never upgrade process-capable cleanup to verified without the Pi receipt.
- Preserve broker-side bounded caller response and sticky quarantine.

#### Required tests

- never-settling abort, dispose called once;
- late abort success after dispose;
- abort rejection plus dispose success/failure;
- active/completed Bash risk remains unknown;
- no duplicate disposal across stop/restart/shutdown callers.

---

## Phase 4 — Abrupt-owner recovery gaps

### 4.1 Quarantine failed writable records after abandoned-owner takeover

#### Current problem

Startup's `ABANDONED_OWNER_RECOVERY` conversion excludes `failed`. A failed state is not proof of verified cleanup. For example, mailbox enforcement can mark a still-owned worker failed without beginning cleanup.

#### Target behavior

After Linux owner-generation fencing confirms abandoned takeover:

- quarantine every mutation-capable record that lacks authoritative verified-clean shutdown evidence;
- do not exempt `failed` merely because of its label;
- preserve already clean `archived` records;
- preserve `stopped` only when current durable state proves it resulted from verified cleanup; otherwise quarantine it too;
- restore quarantine capability/run-slot facts before ordinary capacity.

#### Required tests

- failed writable record with surviving background heartbeat;
- stopped-after-verified cleanup remains restorable;
- stopped legacy/ambiguous record fails closed;
- read-only failed record does not create unnecessary global mutable quarantine;
- config changes cannot erase old mutation capability.

### 4.2 Keep process quiescence as an explicit upstream gate

No extension-only code may claim generic process quiescence on Pi 0.81.1.

Required upstream Pi capability:

- public, idempotent, session/generation-scoped cleanup receipt;
- provider and tool callbacks settled;
- every session-owned process group/tree retained after direct-shell exit and confirmed absent;
- active and previously completed Bash groups covered;
- unsupported/escaped topology returns `unknown`;
- platform-specific POSIX and Windows confidence stated explicitly.

Required upstream tests:

- active Bash direct child plus descendant;
- successful Bash whose redirected background descendant survives direct-shell exit;
- abort/start, timeout/exit, already-exited group, repeated cleanup;
- `setsid`/escaped child returns unknown unless stronger containment exists;
- Windows process-tree/job equivalent for any verified Windows claim.

Extension acceptance after a released Pi capability:

- explicit feature/minimum-version gate;
- package smoke with the supported runtime;
- real E2E proves replacement/capacity/namespace release only after receipt;
- older Pi remains fail-closed.

---

## Phase 5 — Compatibility and operator-surface consistency

### 5.1 Strengthen the Pi runtime guard

#### Current problem

`src/pi-compat.ts` checks top-level symbol presence but not several required public methods or event semantics. A near-compatible Pi version may pass the guard and fail after mail acceptance.

#### Target behavior

Probe only supported public surface, before broker/mail acceptance:

- required `SettingsManager` load/override/getter behavior;
- required `SessionManager` open/create/getBranch/custom-entry methods;
- required model registry/runtime auth/provider methods;
- required extension/session APIs used by the package;
- event-semantic compatibility remains owned by the tested Pi version matrix, not guessed through runtime introspection.

Keep wildcard peers only because Pi packaging requires host-provided peers. Documentation must state that feature probes improve failure messages but do not certify behavioral compatibility.

### 5.2 Remove count and guidance drift

- derive `AgentInspection.pendingReplies` from `archiveBlockers.pendingReplies.count`;
- add outbound reservation coverage;
- ensure cleanup guidance says Pi 0.81.1 has no automatic process-risk recovery rather than telling users merely to wait;
- remove prompt wording that permits semantic redelegation while the original possible-effect obligation remains open;
- remove “relevant to the task” from final mailbox discipline;
- bound capability summaries and keep operational detail in tool results/docs where possible.

### 5.3 Preserve upstream filesystem limitations honestly

No extension change in this phase should pretend to fix Pi's missing-target symlink/hard-link mutation-queue aliases.

- Keep docs scoped to best-effort direct-mutation serialization.
- If upstream Pi fixes nearest-existing-ancestor/inode serialization, add a dependency test before strengthening claims.
- Cross-parent workspace mutation isolation remains outside this extension unless a separate product requirement authorizes a project-wide cooperative lease.

---

## Cross-phase deterministic validation matrix

| Area | Required proof |
|---|---|
| Mechanical completion | One attributable request only; multiple obligations remain open |
| Nested dependency | Parent obligation parks; child reply/failure wakes parent; no premature answer |
| Failed recipient | Mail queues; only explicit restart creates worker |
| Collected reply | Crash boundary produces one eventual presentation or documented upstream block |
| Settings | Global/project bytes unchanged across worker lifecycle and effort changes |
| Auth | Runtime/stored/environment/OAuth source matrix fails closed on mismatch |
| Model liveness | Spaced deltas survive idle; no-delta stall expires; run stays absolute |
| Retry liveness | Backoff longer than idle reaches next attempt; run stays absolute |
| Error privacy | Registry/alert bounded and redacted; session retains protected detail only |
| Tool truth | Activated tools drive live capability; prospective intent labeled |
| Orphan mutation | Unknown effect retained, never confirmed or mislabeled failed |
| Hung abort | Dispose called once; report stays pending/unknown as appropriate |
| Abandoned failed worker | Sticky quarantine before any writable restore |
| Compatibility | Load fails before broker startup on missing required public method |
| Counts/prompts | Canonical blocker counts and one consistent recovery policy |

All E2E assertions must parse RPC JSON, registry JSON, mail JSONL, session branches, owner metadata, and readiness artifacts through their schemas and stable IDs.

## Validation commands and artifact discipline

For each phase:

1. Write and preserve the first failing focused test.
2. Capture complete output to a durable phase-specific directory under `/tmp` or the approved harness artifact directory.
3. Fix the root mechanism.
4. Run focused unit/integration/E2E suites.
5. Run:

```bash
npm run validate
npm run check:package
npm run check:secrets
```

6. Run `git diff --check` and inspect the complete diff.
7. Commit a coherent phase and push `main`.
8. Confirm `HEAD == origin/main` and a clean worktree.

Do not rerun merely to discover which test failed; preserve and inspect the first failure artifact.

## Release gates

Release remains blocked until:

1. Every P1 extension defect has a deterministic regression and passing implementation.
2. Default nested spawning is disabled or the parent/child obligation lifecycle is proven end to end.
3. No worker lifecycle operation mutates global/project Pi settings.
4. Runtime auth cannot silently choose another credential source/account.
5. Provider/session errors outside the worker session are bounded and sanitized.
6. Failed identities require explicit recovery.
7. Multi-request fallback cannot fabricate substantive completion.
8. The collected-reply crash guarantee is either implemented with a supported receipt or explicitly narrowed.
9. Abandoned failed writable records cannot auto-restore.
10. Full generic process quiescence is not claimed until the released Pi receipt is consumed.
11. Package policy, supported Pi package smoke, deterministic suites, and secret scan pass from preserved first-run artifacts.
12. A final independent review finds no S0/S1 issue in the enabled-by-default product surface.

## Final review gate

After implementation, run independent read-only reviews with these perspectives:

- correctness;
- overengineering/simplicity;
- software engineering;
- agentic engineering;
- LLM/ML engineering;
- Pi software-engineer domain;
- virtualization/isolation;
- Linux/process/filesystem behavior.

Every review must inspect the same pushed commit. Findings must cite exact paths/symbols and distinguish extension defects, Pi-core blockers, provider limitations, and documented non-goals.

## Overengineering guard

Do not solve these problems by introducing:

- a second mail or orchestration protocol;
- automatic obligation cancellation;
- automatic provider retry/restart/failover;
- provider-qualified email addresses;
- a persistent capacity ledger;
- process polling by executable name;
- PID-only production proof;
- a generic routing-policy framework;
- containers/cgroups/VMs for problems that Pi process-group receipts or extension state can solve;
- exact-once claims over an at-least-once crash model;
- new durable schemas when an existing canonical envelope/session/work record suffices.

Add a new durable field only when its crash boundary, migration, compaction, rollback, bounds, and authoritative owner are specified and tested.

## Explicit residual non-goals

Even after this plan is complete, the package does not promise:

- security isolation for untrusted workers;
- containment of hostile `setsid`/double-fork escape without an OS containment domain;
- cross-parent workspace serialization;
- sudden-power-loss/fsync durability;
- compatibility with untested Pi versions;
- exactly-once external side effects from nondeterministic models;
- automatic provider/account failover;
- upstream Pi direct-mutation alias correctness before Pi ships it;
- live-provider behavior without separate canary evidence.
