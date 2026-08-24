# Remaining Open Problems — Clustered Release Plan

Date: 2026-08-23
Status: extension-owned work implemented; final evidence regeneration in progress
Historical implementation baseline: `770da60d99278e45cf691698a0edbe62a84e9ed8`
Explicit release evidence base: `4a494e06a1258a26898ec4bba8c9f8123b6613c2`
Remediation commits: `018f25b` (presentation/lock/redaction), `1465343` (runtime/admission/start quarantine), final docs/evidence commit recorded by release metadata
Release posture: extension-owned P1 findings are closed; generic Pi process receipt, durable session-presentation receipt, and mutation-alias identity remain external gates

Every finding in these cluster plans was revalidated against `f32aa1e`; the only repository change between the implementation and revalidation baselines was the first overview plan.

## Purpose

This is the index and shared release contract for the remaining work. Detailed mechanisms, failure timelines, decisions, work packages, and red/green gates are split into five implementation clusters so one large plan does not become a second source of truth.

Historical `/tmp` artifacts are not release evidence. The final candidate evidence is regenerated under `.test-workspaces/review-remediation/` from the explicit base above and records base/candidate metadata, canonical changed files, complete command logs, and exit statuses.

## Cluster map

| Order | Cluster | Problems owned | Priority | Detailed plan |
|---|---|---|---|---|
| 1 | Durable mail and obligation semantics | completion attribution, failed-recipient admission, nested delegation, collected-reply presentation, canonical reply blockers | P1 | [`remaining-open-problems/01-mail-obligations.md`](remaining-open-problems/01-mail-obligations.md) |
| 2 | Isolated worker and provider boundary | settings persistence, credential-source equivalence, model-option compatibility, safe provider errors | P1 | [`remaining-open-problems/02-runtime-provider-boundary.md`](remaining-open-problems/02-runtime-provider-boundary.md) |
| 3 | Run liveness, capability truth, and effect evidence | model/retry idle liveness, activated tools, orphan mutation outcomes, unverified shell/custom evidence, hung-abort disposal | P1/P2 | [`remaining-open-problems/03-runtime-truth-and-liveness.md`](remaining-open-problems/03-runtime-truth-and-liveness.md) |
| 4 | Crash recovery and OS containment | failed writable takeover, generic process quiescence, filesystem mutation aliases | P1/P1 external | [`remaining-open-problems/04-crash-recovery-and-containment.md`](remaining-open-problems/04-crash-recovery-and-containment.md) |
| 5 | Pi compatibility and release proof | runtime feature guard, prompt/operator consistency, bounded capability summaries, final validation and reviews | P2/P3 | [`remaining-open-problems/05-compatibility-and-release.md`](remaining-open-problems/05-compatibility-and-release.md) |

## Why these clusters

- **Cluster 1 owns protocol truth.** Every issue changes when a mail obligation is accepted, answered, parked, failed, or presented.
- **Cluster 2 owns the isolated Pi runtime boundary.** Every issue concerns state or data that must remain equivalent without leaking settings, credentials, provider internals, or errors across that boundary.
- **Cluster 3 owns live runtime observations.** Every issue concerns ephemeral facts that the broker currently misses or misclassifies.
- **Cluster 4 owns crash and kernel limits.** Every issue requires distinguishing durable extension state from facts only Pi or the operating system can prove.
- **Cluster 5 owns compatibility and release claims.** It consumes the earlier cluster contracts rather than changing their state machines.

Do not merge Clusters 1 and 3 merely because both touch `src/broker.ts`; their invariants and test oracles are different. Do not put the Pi process receipt into Cluster 2 merely because workers use Pi; it is an OS-containment boundary, not a provider-runtime boundary.

## Shared invariants

Every cluster must preserve these properties:

1. A durably accepted mail ID is never represented as unaccepted and is never silently replayed as a new obligation.
2. One result answers only the exact request it substantively satisfies.
3. Provider or lifecycle recovery never duplicates possible side effects without an explicit operator decision.
4. Failed, stopped, paused, quarantined, archived, queued, running, and idle remain distinct facts.
5. Reply reservation, answer, cancellation, collection, delivery, and presentation use stable IDs and explicit crash boundaries.
6. Idle/stall policy and the absolute run deadline remain independent.
7. Worker settings and credentials cannot alter the main session or silently select another credential path.
8. Registry, prompts, UI, and main alerts contain only bounded safe summaries; native worker sessions retain protected diagnostic detail.
9. Live capability claims come from activated tools; configured intent remains separately identifiable.
10. Unknown process or mutation quiescence remains fail-closed.
11. No count is derived by text-matching a structured event stream.
12. No extension-level automatic provider retry, provider switch, cross-provider rebind, obligation cancellation, or effect replay is introduced.

## Dependency graph

```text
Cluster 1 protocol decisions
  ├─ failed-recipient disposition feeds Cluster 5 operator wording
  └─ collection receipt decision may remain blocked on Pi core

Cluster 2 worker/provider isolation
  ├─ safe error summary is reused by Clusters 3–5
  ├─ worker-local SettingsManager is required before reliable liveness E2E
  └─ adds its required Pi method probes before using the new surface

Cluster 3 runtime truth
  ├─ activated-tool truth feeds Cluster 4 mutation capability
  └─ unknown-effect work evidence feeds restart guidance in Clusters 1 and 5

Cluster 4 crash/containment
  └─ defines which cleanup guarantees Cluster 5 may publish

Compatibility probes are cross-cutting prerequisites:
  └─ each owning cluster adds the supported public-method probes it needs

Cluster 5 compatibility/release
  └─ performs the final probe audit and release review after Clusters 1–4 settle
```

## Execution order

### Wave 1 — protocol and isolation

1. Cluster 1 work packages 1–3: mail completion, failed-recipient admission, nested-delegation default.
2. Cluster 2 work packages 1–2: worker-local settings and auth-source policy.
3. Cluster 2 work packages 3–4: model-option characterization and bounded provider errors.
4. Re-run the Cluster 1 collection decision with the verified Pi surface; implement it only if a supported receipt exists.

### Wave 2 — runtime and recovery truth

5. Cluster 3 model/retry liveness.
6. Land Cluster 3 activated-tool generation evidence and Cluster 4 failed-writable abandoned-owner classification as one atomic work package; never classify from current-profile tools and repair history later.
7. Cluster 3 unknown-effect work evidence and disposal progression.
8. Run Cluster 4 takeover/containment regressions against the same capability-epoch commit.
9. Keep the generic process receipt and filesystem alias work blocked on Pi core unless released APIs appear.

Each wave updates `src/pi-compat.ts` before it invokes a newly required Pi method. Compatibility is not postponed to final cleanup.

### Wave 3 — compatibility and release

10. Cluster 5 audits the accumulated module/prototype/extension-API probes.
11. Cluster 5 bounds capability summaries and audits prompt/operator wording already changed by the owning clusters.
12. Full deterministic validation, package smoke, secret scan, cross-domain review, and release decision.

Each work package lands in a coherent commit. Push after its focused tests and the applicable full gate pass. Do not accumulate all clusters in one unreviewable patch.

## Priority and ownership

### P1 extension-fixable

- mechanical completion can close unrelated requests;
- ordinary mail can implicitly restart a failed identity;
- unknown/default profiles can spawn despite incomplete parent/child obligation handling;
- file-backed worker settings are mutated through `AgentSession` setters;
- runtime auth can fall back to a different source class;
- raw or unbounded provider errors escape the worker session;
- abandoned-owner recovery excludes failed writable records;
- live capability and mutation evidence can be stale or falsely terminal where they affect safe recovery.

### P1 external or guarantee-limiting

- Pi 0.81.1 exposes no public receipt that a collected tool result was durably presented before a mail answer is committed;
- Pi 0.81.1 exposes no public receipt that every active and completed session-owned process group/tree is absent.

An external blocker does not justify an unsafe extension workaround. Narrow or disable the affected guarantee and state the exact upstream requirement.

### P2/P3

- long model streams and Pi retry backoff can be misread as idle;
- a never-settling abort prevents disposal from being attempted;
- `pendingReplies` has two calculations;
- Pi runtime probes do not cover every required public method;
- prompt recovery advice and capability summaries can drift or grow too large.

## Shared test discipline

For every extension-fixable issue:

1. Add the focused failing regression first.
2. Preserve the first run's complete output in a phase-specific artifact directory.
3. Assert canonical JSON/RPC/session/mail/registry structures through parsers and stable IDs.
4. Fix the smallest mechanism that restores the invariant.
5. Run focused unit, integration, and real Pi E2E coverage named in the cluster.
6. Run the full release commands from one pushed commit.

Structured artifacts must be parsed and deduplicated before counts are reported. A grep count is not a measurement.

## Shared validation commands

```bash
npm run validate
npm run check:package
npm run check:secrets
git diff --check
```

Capture full output to durable files instead of relying on terminal truncation. On failure, inspect only bounded relevant sections while preserving the original artifact.

## Cross-cluster release gates

Release remains blocked until:

1. Every P1 extension defect has a deterministic red/green regression.
2. Mechanical fallback cannot fabricate answers for unrelated requests.
3. Failed identities require explicit same-identity recovery.
4. Default nested spawning is disabled until its parent/child lifecycle is proven.
5. No worker lifecycle or effort operation writes global or project Pi settings.
6. Unsupported credential-source transitions fail before side-effecting worker execution.
7. Model/provider option failures are either fixed at the correct Pi/provider layer or fail closed with a reproducible diagnosis.
8. Provider/session errors outside native worker sessions are bounded and sanitized.
9. Live tool capability and orphan mutation outcomes cannot understate possible effects.
10. Failed writable records cannot auto-restore after abandoned-owner takeover.
11. Collected-reply and generic process-quiescence claims are narrowed unless Pi supplies the required receipts.
12. The supported Pi package smoke, deterministic suite, package policy, license policy, and secret scan pass from preserved artifacts.
13. Independent reviewers find no S0/S1 defect in the enabled-by-default surface.
14. `HEAD == origin/main` and the worktree is clean.

## Existing partial patch

`/tmp/pi-subagent-runtime-remediation-failed.patch` is local failure evidence, not an implementation baseline. It contains broad changes across runtime, broker, journal, work-ledger, docs, and tests from workers that failed before a trustworthy final result.

Rules:

- never apply it wholesale;
- inspect each hunk against the relevant cluster's red test and current source;
- copy only a minimal, independently understood change;
- do not inherit its tests as proof without first confirming that they fail on the current implementation;
- do not cite the patch as durable repository evidence because `/tmp` is not a project artifact.

## Final independent review gate

Run two non-overlapping independent reviews of the same pushed commit:

1. **Product correctness review:** correctness, overengineering/simplicity, software engineering, agentic systems, and LLM/ML behavior.
2. **Runtime safety review:** Pi SDK/extension internals, virtualization/isolation, and Linux process/filesystem behavior.

This preserves all requested perspectives without eight overlapping coordination passes. Findings must cite exact paths and symbols and label ownership as extension, Pi core, provider/model metadata, OS limitation, or explicit non-goal.

## Shared overengineering guard

Do not introduce:

- a second mail/orchestration protocol;
- automatic obligation cancellation;
- automatic provider retry, restart, switch, or failover;
- provider-qualified email addresses;
- a persistent capacity ledger;
- process polling by executable name;
- PID-only production proof;
- a generic routing-policy framework;
- containers, cgroups, or VMs for an extension-state defect;
- exactly-once claims over an at-least-once crash model;
- a new durable field without its owner, migration, bounds, compaction, and crash transitions.

## Residual non-goals

Completion of all clusters still does not promise:

- security isolation for untrusted workers;
- containment of hostile `setsid`/double-fork escape without an OS containment domain;
- cross-parent workspace serialization;
- sudden-power-loss/fsync durability;
- compatibility with untested Pi versions;
- exactly-once external side effects from nondeterministic models;
- automatic provider/account failover;
- upstream Pi direct-mutation alias correctness before Pi ships it;
- live-provider behavior without separate canary evidence.
