# Cluster 2 — Isolated Worker and Provider Boundary

Status: proposed — implementation not started
Revalidated at: `f32aa1efeb2991cd591cf70f497c7d510d46af01`
Priority: P1
Depends on: exact persisted provider/model binding already implemented
Blocks: reliable worker startup, effort changes, external-provider release

## Cluster objective

Build isolated workers from the same supported Pi configuration without letting them persist main-session settings, switch credential source, forward an unsupported provider option blindly, or copy raw provider failures into durable/shared surfaces.

## Current creation path

At extension `session_start`:

1. `src/index.ts` snapshots registered providers in `WorkerRuntimeFactory`.
2. Each worker factory call creates a new `ModelRuntime` using the same `auth.json` and `models.json` paths.
3. Registered native/configured providers are copied into that runtime.
4. `WorkerRuntimeFactory.create()` resolves the exact persisted provider/model and compares only auth presence.
5. `SdkWorker.start()` constructs a file-backed `SettingsManager.create(...)`.
6. The worker creates an `AgentSession`, then calls session setters for steering, follow-up, and effort.

Provider/model binding is durable. Settings persistence and credential equivalence are not yet safe enough.

## Issue inventory

| ID | Problem | Broken invariant | Owner | Gate |
|---|---|---|---|---|
| RUNTIME-1 | Worker session setters persist shared settings | worker-local control cannot mutate main defaults | extension | P1 |
| RUNTIME-2 | Auth presence can hide a source/account change | exact model binding is not credential equivalence | extension/Pi API limit | P1 |
| RUNTIME-3 | `prompt_cache_retention` failure path is uncharacterized | model/provider options must be compatible or fail closed | Pi metadata/provider/extension preflight | P1 operational |
| RUNTIME-4 | Raw provider errors escape into registry/main context | shared diagnostics must be bounded and safe | extension | P1 |

---

## RUNTIME-1 — Worker-local settings without file persistence

### Evidence in the current mechanism

`SdkWorker.start()` uses:

```text
SettingsManager.create(cwd, agentDir, { projectTrusted })
settings.applyOverrides(...)
createAgentSession({ settingsManager: settings, ... })
session.setSteeringMode("all")
session.setFollowUpMode("all")
```

`SdkWorker.setEffort()` calls `session.setThinkingLevel(level)`.

Pi 0.81.1 documents that `SettingsManager` setters modify global settings by default and queue persistence. Pi's `AgentSession` implementation delegates these session setters to the settings manager:

- `setSteeringMode()` → `settingsManager.setSteeringMode()`;
- `setFollowUpMode()` → `settingsManager.setFollowUpMode()`;
- `setThinkingLevel()` → `settingsManager.setDefaultThinkingLevel()` when the effective level changes.

`applyOverrides()` itself is in-memory, but subsequent session setters target the file-backed manager.

### Concrete failure timelines

#### Worker startup mutates queue defaults

1. Main has steering/follow-up modes different from `all`.
2. A worker starts.
3. `session.setSteeringMode("all")` and `setFollowUpMode("all")` enqueue global settings writes.
4. A later main or unrelated session observes worker-owned defaults.

#### Effort change mutates the global default

1. Two workers have different intended effort.
2. `/agents effort worker-A high` calls `setThinkingLevel("high")`.
3. Pi persists `defaultThinkingLevel: high` globally.
4. A new main/worker session inherits the unrelated worker's effort.

### Target architecture

Use one immutable source snapshot and one no-write manager per worker:

1. At extension `session_start`, create one file-backed source manager for the actual `cwd`, `agentDir`, and project-trust decision.
2. Drain and report its load errors once.
3. Clone its public `getGlobalSettings()` and `getProjectSettings()` results into a minimal extension-owned in-memory `SettingsStorage` implementation.
4. For each worker, create a fresh `SettingsManager.fromStorage(snapshotStorage, { projectTrusted })` so Pi performs its own migration and global/project nested merge.
5. Apply worker-only overrides to that manager: steering `all`, follow-up `all`, and default thinking level equal to the record effort.
6. Pass only that worker-owned manager to `DefaultResourceLoader` and `createAgentSession()`.
7. Every later session setter writes only to the worker's in-memory storage.

The source manager must never be passed into a worker `AgentSession`. The snapshot storage contains two structured settings documents and a synchronous in-memory `withLock` update; it does not reimplement Pi's merge rules. If settings change on disk, an extension reload creates the next snapshot.

Pi 0.81.1 exposes `SettingsManager.fromStorage()` on the exported class even though the SDK guide foregrounds `create()` and `inMemory()`. Add a load-safe feature probe and exact-version package smoke for this method. Do not import private module paths or reach into `SettingsManager` private fields.

### Behavior to preserve and characterize

The snapshot must retain Pi's effective behavior for:

- retry enabled/max/base and provider retry values;
- transport;
- proxy, HTTP idle, and WebSocket connect timeouts;
- compaction and branch summary;
- shell path and shell prefix;
- package/resource paths used by the worker loader;
- thinking budgets;
- enabled/default tools only if Pi consumes them despite explicit `tools`;
- trusted versus untrusted project settings.

### Red tests

Use real temporary global/project settings files and call `flush()` on all relevant managers before comparison.

- global file byte snapshot before/after worker start;
- trusted project file before/after worker start;
- untrusted project settings are not inherited;
- `/agents effort` changes the worker and session entry only;
- two worker effort changes cannot race the global default;
- restart/resume preserves worker-local effective settings;
- invalid global/project JSON yields bounded scope-only activity and no file rewrite;
- worker retry/transport behavior still uses effective trusted settings.

### Done when

- global and project settings files remain byte-equivalent across worker lifecycle and effort operations;
- worker behavior retains the explicitly characterized effective settings;
- no test relies only on spying on a setter; real file non-mutation is asserted.

---

## RUNTIME-2 — Credential-source equivalence

### Evidence in the current mechanism

`WorkerRuntimeFactory.create()` currently checks:

```text
parentAuth = source.getProviderAuth(providerId)
workerAuth = runtime.getAuth(model)
if parentAuth exists and workerAuth does not -> fail
```

If both exist, creation succeeds even when the parent uses runtime-only credential A and the isolated runtime resolves stored/environment credential B.

Pi 0.81.1 exposes non-secret status through `getProviderAuthStatus()`:

```text
configured: boolean
source: stored | runtime | environment | fallback |
        models_json_key | models_json_command
```

`AuthResult.source` is a human-readable UI label, not a stable account identifier. `CredentialInfo` identifies provider and credential type, not account identity. Therefore the extension can enforce supported source equivalence without comparing secrets, but cannot prove arbitrary account identity across every provider hook.

### Policy to implement

#### Allow by construction

- **stored**: parent and worker use the same explicit `authPath`, one provider credential entry, and the same registered provider snapshot;
- **environment**: same process environment and provider snapshot, after deterministic status agreement;
- **models_json_key**: same `modelsPath` and provider snapshot, provided resolution is not a command;
- no-auth/keyless provider only when both runtimes report the same supported state.

#### Fail closed

- **runtime** parent source: isolated runtime does not inherit the override; reject before worker execution unless Pi exposes a secure exact override-transfer API;
- **models_json_command**: command output may change between resolutions; reject isolated equivalence unless Pi exposes a shared resolved credential context;
- **fallback**: provider-owned resolution cannot be assumed equivalent without a provider/Pi receipt;
- parent/worker source mismatch;
- source status missing or indeterminate for a provider that requires auth.

This policy may be narrowed after deterministic Pi tests. Environment allowance also requires the same non-secret source label/process context. It must not be widened by comparing token strings, headers, or secret-derived fingerprints.

### Pre-acceptance versus post-acceptance

For a brand-new identity, source incompatibility is deterministic before mail acceptance. Add a provider/model preflight before `email.created` so rejection creates no obligation.

For an existing failed identity, ordinary mail admission must not resolve current catalog/auth readiness at all; Cluster 1 accepts against the persisted identity and queues the envelope. Explicit `restart()` performs the readiness/source checks. For a paused identity that is being made runnable:

- keep any already accepted envelope queued on readiness failure;
- persist a bounded provider-readiness failure;
- require explicit correction/reload/restart as appropriate;
- never mark an accepted request as unaccepted.

The preflight and runtime creation must use the same provider snapshot generation. If configuration changes, require extension reload rather than silently changing the decision.

### Red test matrix

- parent runtime override + worker stored auth;
- parent runtime override + worker no auth;
- parent and worker same stored API key source;
- stored OAuth with refresh path;
- same environment source;
- environment versus stored mismatch;
- models JSON literal/environment key;
- models JSON command;
- provider fallback resolver;
- custom native and configured registered providers;
- auth-source change after extension snapshot requires reload;
- diagnostics contain provider/source class only, never keys, headers, URLs, or credential labels with secret-like values.

### Done when

- no allowed path silently changes source class;
- unsupported equivalence fails before effectful worker execution;
- docs say “supported credential-source equivalence,” not universal account proof.

---

## RUNTIME-3 — Model/provider option compatibility

### Observed failure

Two real `gpt-5.6-sol` remediation workers terminated with:

```text
prompt_cache_retention is not supported on this model
```

This is operational evidence of a rejected provider option. It does **not** prove that the worker `SettingsManager` caused the option.

Pi 0.81.1 provider code can emit `prompt_cache_retention: "24h"` when effective cache retention is long and the model compatibility metadata says `supportsLongCacheRetention`. Long retention can come from provider-scoped/ambient `PI_CACHE_RETENTION`, and compatibility can come from model/provider metadata. Treat those as separate from RUNTIME-1 until a reproducer proves otherwise.

### Characterization questions

For the failing route, record only non-secret facts:

- exact provider ID, model ID, and API family;
- model `compat.supportsLongCacheRetention` effective value;
- parent and worker auth status source class;
- whether the resolved provider environment selects long cache retention, without logging the full environment;
- whether the parent route emits the same request field;
- whether isolation changes provider/model composition;
- whether the rejection occurs before any tool call.

Do not run a paid/live reproducer unless explicitly authorized. Build a deterministic provider fixture that rejects the field with the same typed/streamed failure first.

### Ownership decision

- If the worker selects different model/provider compatibility metadata from the persisted binding, fix the extension snapshot/binding path.
- If Pi's built-in metadata incorrectly enables long retention for the exact model/endpoint, fix or pin the released Pi metadata and add a compatibility gate.
- If user/provider configuration sets long retention for an unsupported proxy, fail preflight with a clear configuration action or require the model override `supportsLongCacheRetention: false`.
- If the provider changes support dynamically, treat that as a live canary/provider limitation; do not add an extension retry that strips the field after failure.

### Forbidden workaround

Do not catch the provider error, mutate the request, and re-prompt automatically. The rejected request may be part of a broader attempt with unknown provider semantics, and extension replay would violate Pi-owned retry and side-effect rules.

### Red tests

- long retention + supported fixture includes the field;
- long retention + explicitly unsupported metadata omits it;
- deterministic rejecting route yields one terminal failure, one accepted envelope, no extension replay;
- parent and worker resolve the same exact model compatibility;
- runtime/provider reload is required after metadata correction;
- unsupported preflight, where deterministically knowable, occurs before mail acceptance.

### Done when

- the real failure mechanism is reproduced without assumptions;
- the fix is applied at the owning layer;
- no model string special-case or silent retry exists in this extension.

---

## RUNTIME-4 — Bounded and sanitized provider/session errors

### Evidence in the current mechanism

- `terminalAgentError()` returns the provider's raw `errorMessage`.
- `SdkWorker` stores that value in `runFailure` and emits it in a failure event.
- `AgentBroker.onWorkerEvent()` assigns the raw value to `record.failure`, `currentActivity`, activity, and main notification.
- retry events include `errorMessage`/`finalError` in activity.
- several startup/restore paths interpolate `errorMessage(error)` separately.

`SdkWorker.activity()` applies a character truncation and whitespace collapse, but there is no single UTF-8 byte/line/control/redaction policy, and the broker can append the raw failure again.

### Target boundary

Add one content-safe summary helper used at every boundary from native Pi/provider detail into shared extension state.

Required properties:

- UTF-8 byte limit, character-safe truncation, and line limit;
- OSC/CSI/control and bidi-control removal;
- whitespace normalization;
- bounded redaction for common authorization/header, signed-query, bearer/key/token, and credential-URL forms;
- a constant fallback when input is empty or cannot be safely summarized;
- no claim of universal secret detection;
- idempotent output so repeated sanitization does not grow or corrupt text.

Keep raw detail only in the native worker session/Conversation surface. Do not copy it to an additional extension log or artifact.

### One-owner rule

- `SdkWorker` converts provider-native error to the safe summary once.
- Broker failure and alert paths consume that summary and add only fixed metadata.
- Broker catches for extension/lifecycle errors also use the same helper before registry/UI exposure.
- Avoid appending the same cause to both `failure` and activity repeatedly.

Rename visible `Provider retry` activity to **Pi agent retry**. Apply the same summary boundary to work-ledger error extraction and broker factory/start/cleanup paths. Document the distinctions among provider/SDK attempt, Pi agent retry cycle, accepted worker run, delegation, and mail obligation.

### Red tests

- oversized multibyte error;
- many-line error;
- CSI, OSC, C0/C1, and bidi controls;
- bearer/header-like secret sentinel;
- signed URL/query sentinel;
- embedded forged email/enforcement markup;
- retry start/end and terminal agent failure;
- registry parse/round trip and main alert remain bounded;
- protected session fixture retains native error while extension surfaces do not.

### Done when

- every provider/session failure crossing into registry/UI/main prompt passes one tested helper;
- tests assert both safe visibility and absence of sentinels;
- docs state redaction is bounded risk reduction, not a secrecy guarantee.

## Compatibility prerequisite for this cluster

Before the implementation invokes new Pi surface, extend the load-safe guard for the methods used here, including `SettingsManager.fromStorage`, `getGlobalSettings`, `getProjectSettings`, and non-secret auth-status methods. Do not defer these probes to Cluster 5. Behavioral semantics remain covered by the pinned Pi tests, not by method presence.

## Cluster work packages

1. **RUNTIME-1a:** characterize preserved settings, snapshot storage, and real file-mutation red tests.
2. **RUNTIME-1b:** add the required Pi probes, introduce per-worker `fromStorage` managers, and remove file-backed session setters.
3. **RUNTIME-2a:** define/auth-test source policy and add its compatibility probes.
4. **RUNTIME-2b:** add deterministic preflight and existing-identity failure behavior.
5. **RUNTIME-3:** reproduce `prompt_cache_retention` path and fix the owning layer.
6. **RUNTIME-4:** land safe summary helper, migrate all shared provider/work-ledger error paths, update labels/docs.

RUNTIME-3 must not be folded into RUNTIME-1 without a reproducer. They are plausible but currently unproven causal paths.

## Cluster validation

Focused files:

- `test/unit/model-runtime.test.ts`
- `test/unit/sdk-worker.test.ts`
- `test/unit/pi-compat.test.ts`
- `test/integration/sdk-worker-start.test.ts`
- `test/integration/pi-retry-characterization.test.ts`
- `test/integration/provider-routing.test.ts`
- `test/e2e/provider-retry.test.ts`
- `test/e2e/provider-routing.test.ts`

Then run the shared release commands from the overview.

## Cluster non-goals

- no secret comparison, token fingerprint, or credential copying;
- no universal account-equivalence claim for arbitrary provider hooks;
- no extension-owned provider retry or option-stripping replay;
- no live paid-provider test without authorization;
- no reimplementation of Pi's complete settings merge.
