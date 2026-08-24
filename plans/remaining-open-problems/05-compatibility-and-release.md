# Cluster 5 — Pi Compatibility, Operator Contract, and Release Proof

Status: proposed — implementation not started
Revalidated at: `f32aa1efeb2991cd591cf70f497c7d510d46af01`
Priority: P2/P3 plus final release gate
Depends on: settled contracts from Clusters 1–4
Blocks: compatibility claim and release-ready declaration

## Cluster objective

Audit the cross-cutting compatibility probes added by each owning cluster, fail before mail acceptance when installed Pi lacks required public structure, keep prompts/UI/docs aligned with actual lifecycle guarantees, bound generated coordinator context, and produce one reviewable release commit with preserved evidence.

## Issue inventory

| ID | Problem | Broken invariant | Priority |
|---|---|---|---|
| COMPAT-1 | Runtime guard probes only part of the used Pi surface | unsupported runtime must fail before broker work | P2 |
| COMPAT-2 | Prompt and operator recovery guidance can contradict protocol safety | one recovery policy across code and context | P2/P3 |
| COMPAT-3 | Effective capability summary can grow without a prompt bound | generated context must remain bounded | P2 |
| COMPAT-4 | Green suite does not cover live/external/platform branches | release claims must match evidence | release gate |

---

## COMPAT-1 — Strengthen the Pi runtime feature guard

### Evidence in the current mechanism

`src/pi-compat.ts` currently probes top-level/static exports such as:

- `createAgentSession`;
- `SessionManager.open/create`;
- `ModelRuntime.create`;
- `SettingsManager.create`;
- rendering/TUI/typebox helpers.

The package later calls additional public methods that are not structurally probed. A near-compatible runtime can pass the guard, accept a session, and fail later during broker restore or worker startup.

### Cross-cutting probe rule

When Clusters 1–4 start using a new Pi method, that same cluster adds the load-safe structural probe before enabling the call. This cluster performs the final inventory; it does not postpone prerequisites until the end.

Probe only documented public members actually used.

#### Static exports

- `SettingsManager.create` and `SettingsManager.inMemory`;
- `SessionManager.create` and `SessionManager.open`;
- `ModelRuntime.create`;
- existing coding-agent/TUI/typebox exports.

#### `SessionManager.prototype`

- `getBranch`;
- `getSessionId` where used by namespace construction;
- `appendCustomEntry` for work-batch markers;
- any entry/tree method consumed by Conversation after the final implementation.

#### `ModelRuntime.prototype`

- `getModel`;
- `getAuth`;
- `getProviderAuthStatus`;
- provider registration methods used by the snapshot.

#### `ModelRegistry.prototype` or extension context facade

- registered provider enumeration/config/native access;
- provider auth status/access used by preflight;
- available-model access.

#### Settings methods

Only probe documented prototype methods actually used by the effective-settings snapshot and error handling, including `drainErrors`.

#### Extension API object

At extension factory entry, load-safely verify the instance methods used before registering or accepting work, including registration, message injection, thinking/tool access, and event subscription. Module-export probes cannot establish that the host supplied a compatible `ExtensionAPI` object.

### What structural probes cannot prove

A method's presence cannot certify:

- event ordering;
- prompt preflight semantics;
- retry settlement semantics;
- `sendMessage()` durability;
- process cleanup;
- provider behavior;
- settings persistence details.

Those remain version-pinned behavior tests and package smoke. Documentation must not describe feature probes as semantic compatibility certification.

### Load-order gate

`assertSupportedPiRuntime()` must run before:

- tool registration with unsupported shapes;
- broker creation;
- namespace/mail journal mutation;
- provider worker creation;
- any accepted email.

The guard itself must remain load-safe: optional access through unknown/missing constructors cannot throw a secondary `TypeError` while composing the missing-feature list.

### Red tests

- missing static `SettingsManager.inMemory`;
- missing `SessionManager.prototype.getBranch`;
- missing `SessionManager.prototype.appendCustomEntry`;
- missing runtime auth/status method;
- constructor exists but prototype is malformed;
- several missing features produce one bounded diagnostic;
- exact supported Pi package smoke passes;
- unsupported synthetic surface fails before broker/state paths are touched.

### Version policy

- Keep dev dependencies pinned to the behavior-tested Pi version.
- Host-provided peer dependencies may remain wildcard when Pi package loading requires it.
- README/package docs must say runtime probes improve failure messages; the tested version remains authoritative.
- Expanding supported versions requires a deliberate matrix, not merely passing structure probes.

### Done when

- every documented public method used during startup/restore is either probed or covered by the exact-version smoke before mail acceptance;
- behavioral compatibility claims are tied to test artifacts, not duck typing.

---

## COMPAT-2 — One operator and prompt recovery contract

### Current conflicts or weak wording

#### Failure recovery

The main coordinator prompt allows a recovery attempt that can include delegating the same scope elsewhere. When the original worker may already have mutation/shell/custom effects, a new identity can duplicate effects while the original obligation remains open.

#### Mailbox finalization

The prompt says to handle outstanding requests “relevant to the task” before final response. Mail obligations are exact and not scoped by the current conversational task; every returned response-required request needs a substantive reply.

#### Cleanup quarantine

Some guidance can read as if waiting will eventually release cleanup. Pi 0.81.1 has no automatic receipt for process-capable generations.

#### Nested delegation

Subagent wording permits redelegation without fully stating that the parent remains responsible and must not answer upstream while the child request is open.

#### Provider retry terminology

Activity says “Provider retry” even though the observed lifecycle is Pi agent retry. Provider/SDK attempts can exist below that layer.

### Canonical policy text

All prompts, tools, UI, and docs should express:

1. A live Pi-managed retry is not terminal; wait for settlement.
2. A terminal failure leaves every original obligation authoritative.
3. Review Work and Conversation; absence of recorded work is not proof of no effect.
4. Recovery of possible-effect work is explicit and uses the same identity/session/provider binding.
5. Do not redelegate the same possible-effect scope while the original obligation remains open unless the user explicitly chooses that risk and resolves the original obligation.
6. Failed recipients queue mail and require explicit restart.
7. Cleanup quarantine for process-capable risk has no automatic release on Pi 0.81.1.
8. Before final response, answer every response-required email returned by `fetch_emails()`, not only those judged relevant.
9. A parent with an open child request remains responsible for its upstream request.

### Source locations

- `src/prompts.ts` shared/main/subagent/enforcement text;
- `src/main-tools.ts` descriptions and rendered guidance;
- `src/sdk-worker.ts` mail tool descriptions/results;
- `src/broker.ts` capacity/archive/failure diagnostics;
- `src/ui.ts` detail panels;
- lifecycle, send, wait, inspect, manage, provider recovery, and configuration docs.

Behavioral wording changes land with their owning cluster: mail/recovery text in Cluster 1, provider text in Cluster 2, and cleanup text in Cluster 4. This cluster audits for residual contradictions rather than delaying protocol truth.

### Red tests

Use semantic assertions for required/forbidden clauses, not snapshots of entire prompts.

- no new-identity recovery suggestion for possible-effect failure;
- exact same-identity recovery wording;
- every mailbox obligation, without “relevant” qualifier;
- cleanup quarantine says no automatic receipt/release;
- Pi agent retry terminology;
- nested parent dependency wording only for `canSpawn` opt-in;
- post-accept failed-recipient send result is internally consistent.

### Done when

- one policy is visible across prompt, tools, UI, and docs;
- no recovery guidance weakens a broker safety gate.

---

## COMPAT-3 — Bound effective capability context

### Evidence in the current mechanism

`effectiveRoleToolSummary()` renders every configured role and exact address with every configured tool into the main coordinator system prompt. Configuration parsing currently does not establish an explicit prompt-output budget for:

- number of roles/addresses;
- number/length of tool names;
- instruction length;
- model policy length.

Trusted configuration can therefore create a very large generated system prompt and crowd out user/task context. Audit registry parsing at the same time for bounded `tools`, `instructions`, activity/current-activity/failure strings, so restored state cannot bypass the prompt/output bounds.

### Target behavior

Apply bounds at both input and rendering layers where practical.

#### Config parsing

- bound role/address entry counts;
- bound canonical key, tool count, tool-name bytes, instructions bytes, and model-policy bytes;
- reject oversized semantic fields or entire affected entries with deterministic bounded warnings; never truncate `instructions`, `modelPolicy`, tool names, or other semantic input mid-boundary;
- preserve built-in required mail tools;
- never include raw rejected oversized content in warnings.

#### Prompt rendering

- use a total UTF-8 byte and line budget;
- list built-in role summaries first;
- list only a bounded number of exact-address overrides;
- omit/truncate only this derived display summary at complete entry boundaries;
- report an omitted count from parsed entries;
- label output as configured intent, not live activation;
- direct the agent to `inspect_agent` for an exact live/prospective decision.

Do not compress entries with hashes. Do not silently summarize custom instructions with an LLM.

### Red tests

- many roles;
- many exact addresses;
- very long tool names/list;
- very long instructions and model policy;
- multibyte limits;
- control/bidi characters in configuration strings;
- prompt stays within byte/line budget;
- omitted count comes from parsed canonical entries;
- exact `inspect_agent` still returns bounded useful details.

### Done when

- generated coordinator context has a deterministic maximum;
- prompt capability summary is explicitly configuration intent;
- live capability comes from Cluster 3 inspection.

---

## COMPAT-4 — Release evidence and review

### Required deterministic suite

From one pushed candidate commit, preserve full logs for:

```bash
npm run check
npm run check:licenses
npm test
npm run test:package
npm run check:package
npm run check:secrets
```

`npm run validate` may orchestrate the first four, but keep the artifact complete and report the exact command/exit status.

### Required focused real Pi E2E

At minimum:

- exact mail request/reply/answer IDs;
- failed recipient accepts/queues without restart;
- single/no mechanical completion behavior;
- nested default disabled and opt-in dependency behavior if shipped;
- settings files unchanged by worker start/effort;
- deterministic auth-source mismatch;
- deterministic model-option rejection without replay;
- long model stream and retry backoff versus idle/run deadlines;
- unknown-effect orphan mutation representation;
- failed writable abandoned-owner takeover;
- cleanup quarantine for active and completed Bash risk;
- exact supported Pi package load and RPC framing.

### Structured evidence rules

- RPC: parse JSON lines by event schema and tool call ID.
- Mail: replay canonical journal events, deduplicate by event/mail ID, then count.
- Registry: parse schema and inspect exact identity/generation.
- Session: use `SessionManager` branch entries and exact tool-call/message IDs.
- Process fixtures: parse readiness/heartbeat JSON and state exactly what one observed process proves.
- Test runner: use canonical TAP summary/exit status, not grep counts.

### Independent review gate

Run two read-only reviews of the same pushed commit with non-overlapping checklists:

1. **Product correctness:** correctness, overengineering/simplicity, software engineering, agentic engineering, and LLM/ML behavior.
2. **Runtime safety:** Pi SDK/extension internals, virtualization/isolation, and Linux process/filesystem behavior.

Each finding must include:

- severity S0/S1/S2/S3;
- exact path/symbol;
- reachable failure sequence;
- ownership: extension, Pi core, provider metadata/behavior, OS, or non-goal;
- test or evidence that would close it.

No release while an S0/S1 finding remains in enabled-by-default behavior. Explicitly disabled/config opt-in risks must still be documented and reviewed.

### Live/platform coverage labels

A release report must list what was not tested. Unless separately executed, state as untested:

- paid/live providers;
- sudden power loss and filesystem fsync durability;
- Windows process containment;
- escaped POSIX process groups/sessions;
- alternate Pi versions;
- cross-parent workspace overlap.

Do not convert deterministic custom-provider evidence into a claim about every live provider.

### Candidate hygiene

- inspect all diffs;
- do not apply `/tmp/pi-subagent-runtime-remediation-failed.patch` wholesale;
- commit coherent cluster changes;
- push regularly;
- confirm package contents exclude plans/internal artifacts;
- confirm no credentials, session payloads, or test sentinels enter the package;
- confirm `HEAD == origin/main` and clean status.

## Cluster work packages

1. **COMPAT-1:** audit the probes already added by Clusters 1–4; add only missing module/prototype/extension-API checks.
2. **COMPAT-2:** audit prompt/tool/UI/docs for residual recovery contradictions after owning-cluster changes.
3. **COMPAT-3:** bound config/registry-derived coordinator context.
4. **COMPAT-4a:** run focused/full deterministic release matrix from one commit.
5. **COMPAT-4b:** run the two independent checklist reviews and remediate S0/S1 findings.
6. **COMPAT-4c:** produce go/no-go report with artifact paths and explicit untested list.

Do not start the final review while writers are still changing the candidate commit.

## Cluster validation

Focused files:

- `test/unit/pi-compat.test.ts`
- `test/unit/config.test.ts`
- `test/unit/prompts.test.ts`
- `test/unit/ui.test.ts`
- `test/integration/main-tools.test.ts`
- `test/e2e/extension-load.test.ts`
- `test/e2e/runtime-smoke.test.ts`
- package policy and smoke scripts.

Then run the full candidate matrix above.

## Cluster non-goals

- no claim that method presence proves behavior;
- no alternate Pi-version support without a matrix;
- no unbounded config dump into prompts;
- no live-provider claim from deterministic fixtures alone;
- no release declaration without an explicit not-tested list;
- no hiding external blockers by relabeling them extension fixes.
