# Top 1% Extension Plan

Date: 2026-07-28

## Objective

Make `pi-email-subagent` one of the safest, most useful, best-supported, and easiest-to-adopt extensions in the Pi ecosystem without turning it into a distributed orchestration platform.

The broker core is already unusually strong: durable at-least-once mail, stable IDs, atomic reply reservations, crash reconciliation, lifecycle race handling, bounded queues, stale-model quarantine, live journal maintenance, a real SDK-worker RPC E2E suite, and an interactive dashboard. The remaining work is primarily interoperability, unattended safety, conflict isolation, recoverability, first-run experience, and professional distribution.

## Product principles

1. **Safe to leave running:** explicit lifecycle deadlines, isolation policy, and bounded resources.
2. **Useful in five minutes:** one-command install, one copy-paste delegation, visible reply and cost.
3. **Honest contracts:** at-least-once delivery, explicit trust/isolation modes, tested compatibility claims.
4. **Recoverable by operators:** versioned state, diagnostics, backups, repair/export paths, stable errors.
5. **Small composable surface:** email, persistent identities, explicit lifecycle control, and a few proven recipes—not a workflow language.
6. **Deterministic default validation:** no paid calls in required CI; optional live-provider release evidence.

## Baseline and success metrics

Current baseline:

- 118 deterministic tests passing, including 13 real scripted-provider Pi RPC scenarios.
- Production dependency audit clean.
- Private GitHub repository, not yet published to npm.
- Tested against Pi 0.81.1 and Node 22.19.0.

Implementation status (2026-07-28):

- **Milestone 0 complete:** Google-compatible schemas, native thrown tool failures, 50 KB / 2000-line result bounds, independent 48 KB / 1952-line envelope/fetch budget, compact wait details, direct regressions, and real RPC error-event coverage. Validation: 121/121 tests.
- **Milestone 1 foundation in progress:** package metadata, wildcard host peers, Node engine, `prepublishOnly`, clean packed-artifact install/load smoke, Linux/macOS CI, package allowlist, Dependabot, changelog, security policy, contributing guide, and GitHub templates are implemented. Remaining manual gates: enable private vulnerability reporting/branch protection, record gallery media, make the repository public when approved, and explicitly authorize npm publication.
- **Milestone 2.1 implementation complete:** a proper-lockfile filesystem lease enforces one live broker per namespace, records PID/acquisition metadata, releases on init failure and shutdown, diagnoses contention, and recovers stale leases. Direct stale-lock and live-broker contention regressions pass; a real SIGKILL process E2E remains to complete the full milestone acceptance matrix.
- **Milestone 2.2 implementation complete:** initial delegation resolves finite lifecycle deadlines under administrative maxima, persists crash-safe spawn intent before startup, rejects later silent mutation, discloses the accepted policy, and enforces bounded spawn/prompt/run/stall/abort/dispose/global shutdown behavior with stable timeout diagnostics.
- **Work-first `/agents` implementation complete (2026-07-30):** structured telemetry, crash recovery, privacy boundaries, exact-path conflict warnings, bounded diffs, and responsive Work/Activity/Inbox/Profile views passed five orthogonal reviews and all automated gates. Manual interactive TUI acceptance remains.
- **Current validation:** 162/162 deterministic tests, including scripted-provider read/edit/write/bash attribution, plus clean packed-artifact smoke and production audit. Focused work/UI/lifecycle-race suites pass repeatedly.

Target outcomes:

- Fresh install to first successful reply in under 5 minutes.
- More than 80% completion without intervention for documented recipe-shaped tasks.
- No accepted email disappears under tested storage/process killpoints.
- Zero overlapping writable scopes without an explicit warning or isolation boundary.
- Median recovery from a diagnosed worker failure takes at most two dashboard actions.
- Every compatibility and security claim is backed by an automated test or explicitly documented limitation.

## Milestone 0 — Immediate Pi contract compliance

These are release blockers because they affect provider interoperability, Pi error semantics, and model-context safety.

### M0.1 Google-compatible tool schemas

- Replace `Type.Union(Type.Literal(...))` string enums with `StringEnum` from `@earendil-works/pi-ai`.
- Cover `send_email.priority`, `manage_agent.action`, and any future enum schemas.
- Add schema regressions and a real provider-serialization smoke where practical.

Acceptance:

- Tool schemas contain JSON Schema `enum` values accepted by Google-compatible providers.
- Existing OpenAI/custom-provider E2E remains green.

### M0.2 Native Pi tool failure semantics

- Throw from tool `execute()` for failed operations rather than returning an ignored `isError` property.
- Preserve actionable error messages and safe structured diagnostics through thrown errors or render-safe result handling.
- Keep abort behavior consistent and distinguish cancellation where Pi supports it.

Acceptance:

- Real Pi RPC tests observe `tool_execution_end.isError === true` for invalid send, inspect, wait, and manage operations.
- Failed calls do not mutate mail, capacity, or lifecycle state.

### M0.3 Context-safe tool results

- Bound final/partial tool-result content to Pi's documented `DEFAULT_MAX_BYTES` and `DEFAULT_MAX_LINES` (50 KB / 2000 lines).
- Keep delivery-batch limits independent from tool-output limits.
- Page `fetch_emails`; omit joined reply bodies when needed; provide exact smaller-group/re-fetch guidance.
- Avoid retaining unbounded copies in result `details` when details are not needed for behavior/rendering.

Acceptance:

- Every extension tool result is within both limits, including adversarial multibyte and many-line content.
- Omission is explicit and recoverable through paging or smaller-ID queries.

## Milestone 1 — Public-release foundation

### M1.1 Package metadata and clean install

- Add `repository`, `homepage`, `bugs`, `author`, `engines`, and `publishConfig`.
- Decide peer-dependency policy: follow Pi's documented `"*"` peers or retain a narrow tested range with automated compatibility releases and rationale.
- Add `prepublishOnly` validation and clean tarball-install smoke.
- Confirm npm name availability, then publish only with explicit owner approval.

Acceptance:

- `npm publish --dry-run` is clean.
- A fresh agent directory can `pi install` the packed artifact and exposes all five tools plus `/agents` without repository `node_modules`.

### M1.2 CI and release automation

Required PR checks:

- TypeScript check.
- Unit and integration suites.
- Real scripted-provider RPC E2E.
- Clean packed-package install/load test.
- Production audit, package allowlist/size check, secret scan, and license check.
- Node 22 on Linux and macOS; expand only when support is declared.

Nightly/release checks:

- Repeated race suites with saved seeds.
- Minimum/latest supported Pi matrix.
- Dependency compatibility canary.
- Optional paid live-provider acceptance.

Acceptance:

- Branch protection requires deterministic checks.
- Tagged releases generate changelog/release notes, provenance, and an install canary.

### M1.3 Maintainer and security surface

- Add `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, support/compatibility policy, and GitHub templates.
- Document threat model, trust modes, vulnerability-reporting channel, migrations, rollback, and data deletion.
- Add README badges only after their backing systems exist.

## Milestone 2 — Safe unattended operation

### M2.1 Namespace ownership lock

- Acquire an OS-visible single-writer lock per parent-session namespace before recovery.
- Diagnose a second live owner with PID/session/path information.
- Recover stale locks safely after abrupt process death.

Acceptance:

- Two-process contention and SIGKILL recovery tests pass.
- No concurrent append/rewrite can occur for one namespace.

### M2.2 Lifecycle watchdogs declared by the initial delegation

Every agent has a finite lifecycle policy from its first moment. The `send_email` request that targets an unknown address accepts an optional `lifecycle` override alongside `to`, `subject`, `message`, and `priority`. If omitted, finite configured defaults apply; omission never means unbounded execution.

Resolution is field-by-field:

1. Initial `send_email.lifecycle` override for the new recipient.
2. Exact-address configured policy (`addresses[agent].lifecycle`).
3. Role policy (`roles[name].lifecycle`).
4. Global lifecycle defaults (`lifecycle`).

Conceptual initial delegation:

```json
{
  "to": "worker.long-migration@gpt-5.6-sol.com",
  "subject": "Run the migration",
  "message": "Implement and validate the migration.",
  "priority": "low",
  "lifecycle": {
    "spawnTimeoutMs": 30000,
    "promptAcceptanceTimeoutMs": 30000,
    "runTimeoutMs": 14400000,
    "idleTimeoutMs": 900000,
    "abortTimeoutMs": 10000,
    "disposeTimeoutMs": 10000
  }
}
```

The resolved lifecycle policy is validated, durably associated with the recipient before its worker starts, returned by `send_email`, persisted in the agent record, restored after crashes/reloads, and disclosed by `inspect_agent` and `/agents`. A crash between mail acceptance and record persistence must recover the requested lifecycle from durable spawn intent rather than silently reverting to defaults.

An initial lifecycle override is accepted only when creating/restoring the intended recipient under an explicit contract; a normal later email must not silently mutate a live identity's lifecycle. A future explicit `manage_agent` lifecycle action may change it safely. The sending agent cannot alter its own deadline, and mandatory spawn, abort, dispose, and broker-shutdown bounds cannot be disabled. Configured administrative maxima prevent a delegating child from granting an unbounded lifetime.

Broker shutdown remains a global deadline because it coordinates every worker. All worker-specific phases use the lifecycle resolved from the initial delegation.

Acceptance:

- The first delegation either supplies lifecycle values or receives finite defaults before any worker/provider operation begins.
- Initial-request values override exact-address, role, and global defaults field by field, subject to configured safety bounds.
- The accepted send result, durable state, inspection, prompt/runtime enforcement, and dashboard all agree on the same policy.
- Crash recovery cannot lose or widen the accepted lifecycle policy.
- Hung providers/workers cannot hold capacity or block shutdown indefinitely.
- Timeout transitions preserve queued/open mail, release resources, and expose stable error codes.
- Restarting or explicitly reconfiguring an agent installs fresh timers without inheriting stale timers.
- Config, initial-send validation, persistence/recovery, inspection, timeout, shutdown, and race regressions cover every deadline.

### M2.3 Doctor and support bundle

Add `/agents doctor` and a machine-readable health snapshot covering:

- Package/Pi/Node/OS versions.
- Namespace owner and state schema.
- Registry/journal health, size, retention, queue age/saturation.
- Worker PID/run age/deadlines.
- Provider/model/auth readiness without secrets.
- Isolation backend/policy.
- Last persistence/maintenance/lifecycle errors.

Add an opt-in redacted support bundle and incident playbooks.

## Milestone 3 — State evolution and failure proofing

### M3.1 Versioned migrations

- Independently version registry, mail journal/snapshot, and config schemas.
- Lock, validate, backup, migrate to temp, validate, and atomically replace.
- Reject newer formats with actionable diagnostics.
- Quarantine one corrupt registry record without hiding valid identities where safe.

Acceptance:

- Golden fixtures cover every shipped version and current legacy formats.
- Crash at every migration step leaves either the previous or new readable state.
- Export/import/reset/GC/downgrade behavior is documented.

### M3.2 Systematic fault injection

Introduce injectable filesystem, clock, process, and worker-runtime boundaries. Exercise:

- ENOSPC, EACCES, truncated/short writes, failed rename/chmod.
- Provider error/retry/hang and missing preflight callbacks.
- Listener failures and main-delivery failures.
- Abort/dispose hangs, SIGTERM, and SIGKILL.
- Every durable acceptance/delivery/reply/compaction/migration boundary.

Continuously assert:

- One live transport per address.
- No accepted mail disappears.
- At most one committed reply per request.
- No answered request lacks a delivered reply.
- Capacity leases match records.
- Shutdown leaves no owned workers, timers, listeners, files, or processes.

## Milestone 4 — Conflict and execution isolation

### M4.1 Declared writable scopes

- Writable delegations declare canonical workspace-relative path scopes.
- Warn before concurrently running overlapping writable scopes.
- Show scopes and conflicts in `inspect_agent` and `/agents`.

Acceptance:

- Absolute paths, `..`, and symlink escapes cannot bypass scope comparison.
- Overlap warnings are deduplicated and visible before conflicting work proceeds.

### M4.2 Process transport and baseline sandbox

- Implement a subprocess `WorkerTransport` with a clean environment, independent process-tree kill, stdout/stderr caps, and CPU/memory/run-time controls where supported.
- Enforce workspace-scoped read/write paths, protected secret locations, environment scrubbing, and network deny/allow policy.
- Support explicit `trusted`, `best_effort`, and `required` isolation policies; `required` fails closed.

Acceptance:

- Adversarial tests cover traversal, absolute paths, symlink escape, `/proc`, Pi auth, SSH/cloud credentials, env exfiltration, process grandchildren, and network egress.
- A worker hang/crash cannot crash or indefinitely block main Pi.
- Read-only profiles cannot mutate through bash or indirect tools.

### M4.3 Worktree isolation

- Offer opt-in ephemeral Git worktrees for writable agents.
- Report diff, commit provenance, tests, mergeability, and conflicts before merge-back.
- Keep automatic merging out of scope until the reviewed merge flow is proven.

Optional later differentiator: Gondolin/micro-VM high-assurance backend.

## Milestone 5 — Product experience and adoption

### M5.1 Five-minute onboarding

- Lead README with npm install, try-with-`-e`, and one copy-paste first delegation.
- Use catalog-neutral defaults or first-run guidance instead of assuming internal model IDs.
- Add three sample `subagents.json` presets and scripted demos.
- Record a 30–60 second gallery video/GIF showing fan-out, `/agents`, conversation view, reply collection, and crash recovery.

Acceptance:

- A clean user test reaches a reply in under five minutes without reading reference docs.

### M5.2 Structured recovery actions

- Replace raw failure strings with stable categories and suggested next actions.
- Add retry-last-task after restart with stable request linkage.
- Keep recovery within one or two dashboard actions.

### M5.3 Orchestration map

Add `/agents map` or dashboard tab:

- Nodes: identities with state/model/effort/cost.
- Edges: queued/delivered/open/answered mail and obligations.
- Highlight failures, longest queue age, and conflicting scopes.

### M5.4 Recipes, not a workflow engine

Ship documented/configured patterns:

- Parallel read-only research.
- Implementer → reviewer gate.
- Disjoint multi-worker implementation.
- Repository audit.
- Migration fan-out.

Expose recipes to coordinator prompts; avoid conditional workflow-language machinery.

### M5.5 Ecosystem launch

- Make the repository public only after security/release readiness and explicit owner approval.
- Publish npm package with provenance.
- Add Pi gallery media metadata, GitHub topics, Discussions/Q&A, and announcement material.
- Clearly compare persistent email identities/durability/dashboard with Pi's stock stateless subagent example.

## Milestone 6 — Measured scale and observability

- Index recipient/state/open-obligation mail queries and maintain incremental counters.
- Avoid full snapshot cloning and transcript reparsing on activity-only events.
- Tail transcripts incrementally and parse fully only for recovery/full view.
- Benchmark 1/8/64 agents, 10k/100k mail, large transcripts, burst sends, and long TUI sessions.
- Establish p95 latency, memory, CPU, listener/timer, and file-descriptor regression budgets.
- Add opt-in OpenTelemetry/JSON metrics only after stable internal diagnostics exist.

Do not replace JSONL with SQLite until benchmarks demonstrate that indexing and compaction are insufficient.

## Explicit non-goals for now

- Exactly-once external/model/tool side effects.
- Distributed consensus, HA queues, Kubernetes, or cross-host identity federation.
- Multi-user ACL and collaboration infrastructure.
- Web dashboard.
- Agent marketplace or shared-role registry.
- Vector-store/shared-blackboard memory.
- A parameterized workflow/recipe language.
- Autonomous worktree merging.
- Custom encrypted storage without a defined offline-disk/key-management threat model.
- Full billing ledger or automatic model failover.

## Delivery sequence

1. **0.1 release candidate:** Milestone 0 + package metadata, CI, clean install, changelog/security/contributing docs.
2. **0.2 safe unattended:** namespace lock, per-agent lifecycle deadlines, doctor, structured recovery.
3. **0.3 conflict-safe:** versioned migrations, fault injection, write scopes, worktrees, orchestration map, recipes.
4. **1.0 production boundary:** subprocess isolation, tested platform/provider/Pi matrix, recovery guarantees, measured scale.

Each fixed defect or contract gap receives a regression test. Required CI never calls paid models. Live-provider acceptance remains optional and is recorded as release evidence.