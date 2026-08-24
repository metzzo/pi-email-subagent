# Cluster 4 — Crash Recovery and OS Containment

Status: proposed — partly blocked on Pi core
Revalidated at: `f32aa1efeb2991cd591cf70f497c7d510d46af01`
Priority: P1 extension defect plus P1 external guarantee
Depends on: Cluster 3 activated-tool and unknown-effect contracts
Blocks: writable abandoned-owner recovery and generic cleanup claims

## Cluster objective

After broker loss, restore only facts durable state can prove. Quarantine mutation-capable generations whose cleanup is unknown, and do not substitute PID checks, `abort()`, `dispose()`, or current active-tool maps for process-tree quiescence.

## Existing safety mechanisms

The current implementation already provides:

- per-main-session namespace ownership through `NamespaceLock`;
- owner-generation fencing before abandoned takeover;
- persisted cleanup quarantine with generation, mutation capability, held run slot, and active tool refs;
- exact cleanup lease ownership and atomic release persistence;
- fail-closed quarantine when Pi cannot prove process-capable tool quiescence;
- E2E coverage for an active Bash descendant and a background descendant surviving a completed Bash call.

The remaining extension defect is a state-filter plus durable-generation-evidence hole. The broader process receipt remains unavailable in Pi 0.81.1.

## Issue inventory

| ID | Problem | Broken invariant | Owner | Gate |
|---|---|---|---|---|
| CRASH-1 | Abandoned takeover skips `failed` writable records | failed is not proof of cleanup | extension | P1 |
| CRASH-2 | No authoritative active/completed process-tree receipt | capacity/namespace release needs kernel-backed evidence | Pi core/OS | P1 guarantee |
| CRASH-3 | Missing-target mutation aliases can bypass one queue key | path serialization is best effort | Pi core | upstream limitation |

---

## CRASH-1 — Failed writable records after abandoned-owner takeover

### Evidence in the current mechanism

During `AgentBroker.init()`, abandoned-owner recovery creates an `ABANDONED_OWNER_RECOVERY` cleanup diagnostic only when:

```text
namespaceLock.abandonedOwner
and no existing record.cleanup
and state is not stopped, failed, or archived
and record is mutation-capable
```

Excluding `failed` is unsafe. A failed state can be written before cleanup begins or while a live worker/process-capable generation still exists. Examples include mailbox-enforcement failure paths and other broker transitions that set `record.state = "failed"` independently of a verified cleanup receipt.

### Concrete failure timeline

1. A writable worker starts a mutation/process-capable generation.
2. Broker records `failed` for a terminal policy/provider/settlement condition.
3. The broker process ends abruptly before verified cleanup state is durably established.
4. A new broker acquires the abandoned namespace owner generation.
5. Startup skips the failed record.
6. No activation/run-slot quarantine is reconstructed for that identity.
7. New writable work can be admitted while prior effects or descendants may remain.

### Joint capability-epoch fix

Land this classification together with Cluster 3 LIVE-2. Do not first add `failed` to the state filter using current-profile tools and repair generation evidence later.

The shared durable `workerEpoch` is persisted in this order:

1. `spawning` with conservative configured capability before worker startup;
2. `activated` with exact Pi-activated tools before any prompt admission;
3. `runSlotHeld: true` before prompt admission and false after settlement/verified cleanup;
4. `verified-clean` atomically with cleanup/capacity release.

For legacy records without an epoch, snapshot raw loaded `record.tools` before applying the current profile. The current source already performs abandoned classification before profile overlay; preserve that ordering explicitly during the refactor.

On confirmed abandoned-owner takeover, classify from the persisted epoch/raw legacy evidence:

| Durable evidence | Action |
|---|---|
| existing `record.cleanup` | restore its exact unknown quarantine |
| mutation-capable `spawning` or `activated` epoch | create `ABANDONED_OWNER_RECOVERY` quarantine regardless of `failed`/`stopped` label |
| mutation-capable epoch with `runSlotHeld` | restore exact activation and run-slot holds |
| `verified-clean` epoch | do not invent quarantine solely from `failed`/`stopped` label |
| legacy mutation-capable record without epoch | quarantine conservatively; use raw prior tools, and hold run capacity when state is ambiguous |
| read-only epoch/legacy record | no global mutable quarantine unless other effect evidence requires it |
| clean archived record | remain archived |

For each quarantine:

- set `quiescence: unknown`;
- restore activation/run-slot capacity before ordinary admission;
- preserve queued mail and open obligations;
- block restart/archive/mutable scheduling.

Do not attempt automatic cleanup after takeover. The original in-memory `AgentSession` and cleanup promise owner are gone.

The epoch is not a process receipt. `verified-clean` is valid only for generations that met the narrow existing cleanup policy; process-capable generations remain unknown unless Cluster 4's Pi-core receipt exists.

### Red tests

- failed writable `activated` epoch with no cleanup diagnostic on abandoned takeover;
- epoch reconstructs exact activation/run-slot holds;
- legacy failed writable record conservatively reconstructs holds from raw prior tools;
- failed record with prior/current Bash risk;
- failed read-only record does not create mutable global quarantine;
- failed record with an already persisted cleanup diagnostic preserves that diagnostic;
- verified-clean stopped record remains stopped;
- legacy ambiguous stopped writable record fails closed;
- clean archived record remains archived;
- configuration removes mutation tools after the failed generation;
- activation capacity is reconstructed before ordinary agents;
- queued mail to the quarantined identity remains accepted and queued;
- restart/archive remain blocked.

### Done when

- no mutation-capable failed/ambiguous record can become routable after abandoned takeover without verified-clean evidence or a cleanup receipt;
- capability is based on the exact durable epoch or raw legacy generation evidence;
- no test uses stale lock mtime alone as owner death proof.

---

## CRASH-2 — Generic process/tool quiescence receipt

### Current Pi boundary

Pi 0.81.1 publicly exposes:

- `AgentSession.abort(): Promise<void>`;
- `AgentSession.dispose(): void`;
- tool execution lifecycle events.

It does not expose a session/generation-scoped receipt proving that:

- the provider and callbacks settled;
- every active process group/tree is absent;
- descendants from already completed Bash calls are absent;
- background processes retained after direct shell exit are absent;
- cleanup was idempotently applied to the exact generation.

The extension records `processCapableRisk` for the whole worker generation because an empty active-tool map after a completed Bash call is not proof that redirected background descendants ended.

### Why local extension workarounds are insufficient

#### `abort()`/`dispose()`

These are session lifecycle operations, not documented process-tree receipts.

#### Active tool map

It covers emitted active calls only. Completed Bash can leave descendants.

#### PID checks

A PID can exit and be reused. A direct shell PID does not identify escaped descendants.

#### Process-name scans

Names are ambiguous, race-prone, and unrelated processes can match.

#### Process-group signals

The extension does not receive an authoritative inventory of every group created by built-in Bash across completed calls. A child can create a new session/group.

#### Heartbeat disappearance

A stopped heartbeat proves only that one observed writer stopped, not that all descendants are absent.

### Required Pi-core capability

A public cleanup API or receipt with:

```text
sessionId / worker generation identity
providerQuiescent
callbacksSettled
activeToolReceipts[]
completedProcessGroupReceipts[]
quiescence = verified | unknown
platform/source/detailCode
idempotent repeated-call semantics
```

The receipt must be derived from Pi-owned tool/process bookkeeping, not caller-supplied PIDs.

### POSIX requirements

- create and retain identity for each process group/tree started by Bash;
- cover active and already completed direct shells;
- signal/await all retained groups during cleanup;
- distinguish ESRCH/group absence from permission/unknown failures;
- handle PID/PGID reuse safely through retained process handles/generation ownership where possible;
- report `unknown` for `setsid`, double-fork, namespace escape, or topology Pi cannot prove;
- bound cleanup and retain late settlement evidence.

### Windows requirements

No verified Windows claim until Pi owns and tests an equivalent containment mechanism, normally a Job Object or another authoritative process-tree owner. `taskkill`/PID polling alone is not equivalent proof.

### Required upstream tests

- active Bash direct child and descendant;
- completed Bash with redirected background descendant;
- several concurrent Bash groups;
- abort versus direct-shell exit race;
- timeout versus descendant exit race;
- repeated cleanup/idempotence;
- already absent group;
- permission/error path returns unknown;
- `setsid`/escaped child returns unknown unless actually contained;
- Windows job-tree equivalent for Windows support.

### Extension integration after Pi release

Only after a released supported API exists:

1. add it to the Pi compatibility guard;
2. consume the exact session/generation receipt in `SdkWorker.cleanup()`;
3. release quarantine only for `verified` plus matching active-tool/process receipts;
4. keep older Pi fail-closed;
5. run real E2E proving namespace, activation lease, and run-slot release after receipt;
6. update docs from “unknown” only for the tested platforms/topologies.

### Current release wording

Until then, distinguish two operator states:

- **live cleanup pending:** the exact in-memory cleanup lease still has an owner and may settle late;
- **persisted/process-risk unknown:** the cleanup owner or authoritative receipt is unavailable, so merely waiting cannot manufacture proof.

Also state:

- read-only/no-process-capable workers may use the existing narrow idle/no-risk receipt;
- any generation with Bash/process-capable risk remains unknown;
- stop/restart/archive can remain blocked by cleanup quarantine;
- there is no automatic waiting period after which unknown becomes verified;
- only a future authoritative receipt can strengthen the claim.

---

## CRASH-3 — Direct mutation queue aliases

### Current limitation

Pi's built-in mutation queue canonicalizes existing target paths through `realpath()`. For a missing target it falls back to the resolved path. Two aliases that converge only after creation or through different missing symlink/ancestor paths can therefore use different queue keys.

This is a Pi built-in/custom-tool serialization limitation, not a broker mail/lifecycle defect.

### Release policy

- Keep documentation scoped to best-effort direct-file mutation serialization within one Pi runtime.
- Do not claim a workspace-wide transaction or cross-parent lock.
- Do not implement an extension-global path lock around worker sessions; built-in tools execute inside isolated sessions and the extension lacks a supported universal interception boundary there.
- Do not use path hashing.

### Upstream acceptance

If Pi changes mutation serialization to use a safe nearest-existing-ancestor/inode strategy or another supported alias identity:

- add a dependency test for missing-target symlink aliases;
- test hard-link aliases for existing targets;
- test replacement/rename and concurrent create windows;
- strengthen docs only for the exact supported cases.

### Cross-parent workspace overlap

Different main sessions can still target the same repository. Namespace ownership is intentionally parent-session scoped. A project-wide cooperative lease would change the product's concurrency model and is out of scope unless separately requested.

## Cluster work packages

1. **LIVE-2 + CRASH-1 joint package:** add capability-epoch/migration red tests, persist activation/run-slot phases, and change abandoned-owner classification in one commit.
2. **CRASH-2 upstream:** specify/file the Pi receipt and keep extension tests quarantined/fail-closed.
3. **CRASH-2 integration:** only after a released supported Pi capability.
4. **CRASH-3:** documentation/dependency test only; no local workaround.

CRASH-1 must not wait for CRASH-2. The extension can close the state-filter hole while keeping generic process cleanup unknown.

## Cluster validation

Focused files:

- `test/unit/namespace-lock.test.ts`
- `test/unit/registry-store.test.ts`
- `test/integration/cleanup-quarantine.test.ts`
- `test/integration/lifecycle-policy.test.ts`
- `test/integration/lifecycle-races.test.ts`
- `test/e2e/namespace-lock-sigkill.test.ts`
- `test/e2e/worker-cleanup.test.ts`

E2E assertions must parse owner metadata, registry cleanup diagnostics, readiness files, and heartbeat payloads through their JSON schemas. A single observed process or heartbeat is not a generic quiescence proof.

Then run the shared release commands from the overview.

## Cluster non-goals

- no PID/name polling as proof;
- no automatic quarantine expiry;
- no obligation cancellation to free quarantined capacity;
- no containers/cgroups/VMs unless a separate containment product requirement is approved;
- no hostile-process isolation claim;
- no Windows verification without Windows containment tests;
- no cross-parent project lease.
