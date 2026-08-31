# Configuration

Tool behavior is governed by `subagents.json`, loaded in two layers:

1. **Global**: `~/.pi/agent/subagents.json` — always read.
2. **Project**: `<config-dir>/subagents.json` (normally `.pi/subagents.json`; discovered via Pi's `CONFIG_DIR_NAME`) — read only when the project is trusted.

Project values merge over global values, which merge over the defaults below. Invalid values produce a startup warning and fall back. Changes apply on session start / extension reload.

## Limits

Most deployments should configure only `defaultEffort`, `maxAgents`, `maxConcurrent`, and the global run/idle deadlines. Rate, queue/batch, retention, and reminder values are advanced safety controls; keep their defaults unless measured deployment evidence requires a change. They remain visible here for operators upgrading existing development configurations, but are not part of the recommended 0.1 tuning surface.

| Key | Default | Range | Governs |
|-----|---------|-------|---------|
| `defaultEffort` | `"medium"` | off…max | Effort for agents without a role/address override |
| `modelPolicy` | built-in policy | non-empty string | The "Model selection policy" section of every agent prompt |
| `maxAgents` | `8` | 1–64 | Active registered identities (activation leases) |
| `maxConcurrent` | `4` | 1–32, ≤ `maxAgents` | Simultaneously running workers |
| `maxMessageBytes` | `32768` | 1 B–1 MB | `send_email` message size |
| `maxSubjectBytes` | `512` | 1 B–8 KB | `send_email` subject size (replies get +64 for the prefix) |
| `maxMailsPerMinute` | `60` | 1–10000 | Global send rate (sliding window) |
| `maxMailsPerSenderPerMinute` | `30` | 1–10000 | Per-sender send rate |
| `maxQueuedMessages` | `256` | 1–10000 | Queued inbound per worker, or deferred low main mail across all main aliases |
| `maxQueuedBytes` | `4194304` | 1 B–64 MB | Queued inbound bytes per worker, or deferred low main mail across all main aliases |
| `maxBatchMessages` | `32` | 1–1024 | Emails per worker prompt batch |
| `maxBatchBytes` | `524288` | 1 B–512 KB | Formatted bytes per worker delivery batch; fetch/tool output is independently capped by Pi's 50 KB / 2000-line recommendation |
| `maxRetainedEmails` | `10000` | 1–1000000 | Soft cap for retained envelopes; open obligations are never pruned |
| `responseReminderLimit` | `2` | 1–10 | Re-prompts before an agent settling with unanswered mail is marked failed |
| `budgets.maxTurns` | `64` | 1–10000 | Assistant turns admitted in one worker run/enforcement cycle |
| `budgets.maxToolCalls` | `256` | 1–100000 | Tool calls admitted in one worker run/enforcement cycle |
| `budgets.maxTokens` | `1000000` | 1–100000000 | Cumulative input + output tokens in one worker run/enforcement cycle |
| `budgets.maxConsecutiveFailures` | `3` | 1–100 | Terminal runs before same-identity restart opens its circuit breaker |

`maxAgents` and `maxConcurrent` are intentionally separate. `maxAgents` counts current activation leases for persistent identities, including stopped identities and cleanup quarantines. `maxConcurrent` counts current run slots; work can queue for a run slot while its identity already holds a lease. Persisted cleanup records reconstruct their exact `heldRunSlot` value before ordinary admission, so lowering limits preserves inherited quarantine overcommit but does not invent holds for an idle generation or admit ordinary work over them. Waiting for run concurrency or stopping a worker does not free identity capacity. A successful clean archive is the normal explicit lease release.

`inspect_agent` and `/agents` derive current used/limit values directly from the broker's authoritative lease sets. These capacity views are not written to `registry.json` and do not change either default (`8` identities, `4` runs). `inspect_agent` also shows the configured per-run limits and bounded current run turn/tool/token use; each worker prompt states its limits, cumulative identity usage, and circuit-breaker count so the worker can plan before calling tools.

Per-run turn/tool/token budgets fail the exact worker with a bounded `IDENTITY_*_BUDGET` diagnostic while preserving its mail and possible-effect evidence. Consecutive terminal failures persist on the identity; once the circuit opens, another restart is rejected until main stops the inactive identity, reviews effects, and uses `clear_failure`. A clean completed run resets the counter.

## Lifecycle watchdogs

The requested run/idle/cleanup collapse was evaluated against the concrete lifecycle race deployment. Run and idle are the ordinary tuning surface. Spawn admission, prompt acceptance, abort, disposal, and broker shutdown remain distinct fixed safety boundaries because Pi exposes separate asynchronous operations and the cleanup quarantine must report which one did not settle; combining them would either weaken an admission bound or misstate quiescence. Role/address/initial overrides are therefore retained for the existing advanced deployment path rather than silently changing their semantics before 0.1.

Every identity receives finite deadlines. Global defaults (milliseconds) are:

```json
{
  "lifecycle": {
    "spawnTimeoutMs": 30000,
    "promptAcceptanceTimeoutMs": 30000,
    "runTimeoutMs": 14400000,
    "idleTimeoutMs": 900000,
    "abortTimeoutMs": 10000,
    "disposeTimeoutMs": 10000,
    "brokerShutdownTimeoutMs": 60000
  },
  "lifecycleMaxima": {
    "spawnTimeoutMs": 300000,
    "promptAcceptanceTimeoutMs": 300000,
    "runTimeoutMs": 86400000,
    "idleTimeoutMs": 14400000,
    "abortTimeoutMs": 60000,
    "disposeTimeoutMs": 60000,
    "brokerShutdownTimeoutMs": 120000
  }
}
```

All values are integer milliseconds from 1 through `2147483647` (Node's runtime-safe `setTimeout` maximum); zero, negative/fractional values, larger delays, `null`, infinity, and omitted mandatory defaults never mean unbounded. Oversized configured values are ignored with an actionable startup warning rather than overflowing into an almost-immediate timer. During a run, `idleTimeoutMs` is armed only when no known tool call is active; the final parallel tool end starts a fresh idle interval. Active tools never extend the absolute `runTimeoutMs`. Use Bash's per-call `timeout` when a shell command needs a smaller bound.

`abortTimeoutMs` and `disposeTimeoutMs` bound caller responsiveness, not the lifetime of the underlying cleanup Promise. Routing detaches, but replacement of that exact address waits for factory/start settlement, Pi 0.84.2 `AgentSession.abort()`/idle, active tool promises/listeners, and disposal. A timeout keeps only that exact identity failed/quarantined while late success remains observed and can release it; unrelated agents remain schedulable. These defaults are Pi session/tool deadlines, not OS-process containment guarantees, and increasing them does not create cancellation. See [lifecycle.md](lifecycle.md).

For the six worker fields, `lifecycleMaxima` is the administrative ceiling for initial delegation overrides and resolution is field-by-field: initial request → exact address → role → global `lifecycle`. Role and address objects accept those six worker lifecycle fields. `brokerShutdownTimeoutMs` and its maximum are global administrator-only configuration; broker shutdown is never delegated or resolved per worker. See [lifecycle.md](lifecycle.md).

## Roles and addresses

```json
{
  "roles": {
    "reviewer": {
      "effort": "high",
      "tools": ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
      "instructions": "Review for correctness; do not modify files.",
      "lifecycle": { "runTimeoutMs": 7200000 }
    }
  },
  "addresses": {
    "worker.release@gpt-5.6-sol.com": {
      "tools": ["read", "bash", "edit", "write", "send_email", "fetch_emails"]
    }
  }
}
```

- A role is selected by the address **name** segment (`<name>.<task-slug>@…`); `addresses` keys are full addresses and override role fields per key. Keys are trimmed, lowercased, syntax-validated, and canonical-key collisions produce warnings.
- Resolution order per configured profile field: exact address → role → defaults. An initial `send_email.effort` overrides those three levels only while creating an unknown identity; the resulting effort is persisted. Default tools are read-only search plus the two mail tools; `send_email` and `fetch_emails` are always force-included.
- Nested response-required delegation is unsupported. Subagents may send exact replies for requests they own and ordinary mail to main, but cannot create requests for another subagent.
- An unavailable tool name is dropped at worker start and noted in the agent's activity log. A protocol-v2 worker-extension tool is available only when its exact name appears in this effective `tools` list; its required `read`/`write` effect declaration informs prospective inspection. Other unknown/custom configured tools remain conservatively writable and effect-capable. After activation, live capability uses Pi's exact active tool names. Role labels never grant safety or authority. [`inspect_agent`](inspect-agent.md) reports the resolved result and can preview an initial effort override without spawning.
- Layers merge per key: a project role replaces individual fields of the same global role, so a trusted project can widen (or narrow) tools for a role.

Configuration-derived prompt content is bounded without changing semantic fields:

- each source layer accepts at most 64 raw role properties and 256 raw address properties before canonicalization (canonical collisions still count toward that raw input bound), and the merged result separately stays within 64/256 canonical keys;
- each source tools array contains at most 128 raw items before deduplication, and its effective set contains at most 128 unique names including the always-required mail tools;
- each complete tool name is at most 100 UTF-8 bytes;
- `instructions` and `modelPolicy` are each at most 16 KiB of UTF-8 at configuration load; at prompt construction their combined complete values are also budgeted against `contextWindow - maxTokens`, capped at 32 KiB with no synthetic minimum. Because provider tokenizers are not available here, the additions allowance conservatively permits at most one UTF-8 byte per available input token. This budget covers additions only; fixed system prompt and history cost remain Pi-owned and outside it. An oversized model policy is replaced by a short fail-closed listed-model policy with a UI/activity warning (or omitted when even that addition cannot fit, while the fixed shared listed-model invariant remains), and oversized role instructions are omitted whole with a worker activity warning;
- control and bidirectional-control characters are rejected from those semantic strings (ordinary newline/tab layout remains allowed in instructions and model policy); and
- at most 64 fixed-size startup warnings are shown, plus one omitted-warning count. Rejected content is never echoed in a warning.

An oversized collection/profile field is ignored as a whole at its semantic boundary. Instructions, model policy, and tool names are never truncated into a different value. Required `send_email` and `fetch_emails` capability is preserved by effective-profile resolution.

The main coordinator receives a separate derived **configured capability intent** display, not a claim of live activation. Built-in role entries are attempted first, at most 24 exact-address overrides can be displayed, and the complete display is capped at 8 KiB / 64 lines. Entries that do not fit are omitted whole with a count taken from parsed canonical roles/addresses; no tool name is shortened and no capability hash is substituted. The independently bounded available-model section is capped at 6 KiB / 52 lines / 48 entries, includes only complete valid email-domain IDs, labels partial output, reports the exact omitted routable count, and directs exact routing to `inspect_agent`; omitted IDs remain routable. Use `inspect_agent` for the exact bounded live/prospective decision.

## Provider/model routing

The email domain remains a model ID. Provider choice is not configured in `subagents.json` and there is no provider override argument:

- a new globally unique model ID resolves directly;
- a new duplicate ID resolves only when the current main provider owns exactly one candidate;
- a main provider switch changes prospective selection immediately, including switches whose model ID (and therefore main address text) is unchanged;
- an existing identity always resolves its persisted exact provider/model; and
- a missing exact tuple remains unavailable and is never replaced by a same-ID candidate from another provider.

The first accepted mail for a new identity journals exact provider/model binding intent with effort/lifecycle intent. Before that event, the extension prepares the exact isolated runtime plus a detached, deeply frozen model clone later consumed by worker execution and matches all non-secret request model fields, including nested sampling parameters. Provider/runtime-owned catalog models remain untouched. Header-bearing models and dynamic catalog (refresh) extension providers fail closed because Pi 0.84.2 cannot prove their isolated provenance; configured-provider OAuth login/refresh configuration is supported (same-process worker runtime, shared `auth.json`, post-registration availability and credential-source gates). Native public providers with provider-wide headers, OAuth, refresh hooks, or filter hooks are rejected before worker runtime creation or registration. Demonstrably static registrations reuse the same public object/config, then use public `getAvailable(providerId)` for a post-registration availability/auth check that must contain the exact provider/model before readiness. Legacy accepted mail without binding intent migrates only when the model ID has one global candidate; duplicates remain unavailable. See [Provider-aware durable model routing](provider-aware-model-routing.md).

## Pi retry and transport settings

Provider retry/transport policy is not duplicated in `subagents.json`. At extension start, one file-backed Pi manager loads settings with the actual `cwd`, agent directory, and project-trust decision. The extension reports each global/project load-error scope once, clones only public `getGlobalSettings()` / `getProjectSettings()` documents, and gives each worker a fresh no-write `SettingsManager.fromStorage(...)`:

- Pi owns migration and global/project nested merge;
- global settings always apply and trusted `.pi/settings.json` values override them;
- untrusted project settings are ignored;
- worker steering/follow-up modes and persisted effort are applied only to that worker's in-memory manager;
- later session setters, concurrent effort changes, and resumed sessions write only worker memory; and
- Pi defaults are not raised. `retry.provider.maxRetries` remains `0` unless the user explicitly configures it.

The snapshot preserves effective retry/provider-retry values, transport, HTTP/WebSocket timeouts, compaction, branch summary, shell path/prefix, and thinking budgets. Package, extension, skill, prompt-template, and theme sources are stripped from the worker-local snapshot before resource reload so worker startup cannot install/execute missing packages or inherit main-session extension hooks. Invalid settings use Pi's scope fallback and are never rewritten by a worker. Settings changes require extension reload.

## Credential-source readiness

The worker boundary checks Pi 0.84.2's non-secret auth-status surface; it does not resolve or compare credential material. Supported matching source classes are:

- `stored`, using the same explicit `auth.json` path and provider snapshot (including stored OAuth/refresh credentials);
- `environment`, with the same non-secret source context in the same process; and
- non-command `models_json_key`, using the same explicit `models.json` path and provider snapshot.

Runtime overrides, `models_json_command`, provider `fallback`, source/context mismatches, and missing/indeterminate/unconfigured status fail closed. This is supported credential-source equivalence, not proof that arbitrary provider hooks represent the same account. A new identity is preflighted before `email.created`; a known failed identity accepts ordinary queued mail without readiness work, while explicit restart rechecks readiness. Never compare or transfer keys, tokens, headers, URLs, environment values, or secret-derived fingerprints.

## Long prompt-cache retention

`PI_CACHE_RETENTION=long` is provider environment, not a Pi settings-manager field. Pi 0.84.2 emits `prompt_cache_retention: "24h"` for the relevant OpenAI request only when the exact effective model metadata permits long retention, and omits it when `compat.supportsLongCacheRetention` is false. Parent/worker API family and that effective capability must match the extension-start snapshot. If a proxy rejects long retention, correct its model override/upstream metadata and reload. There is no `gpt-5.6-sol` special case, option-stripping retry, automatic replay, provider switch, or fallback.

See [Provider retry visibility and recovery](provider-retry-recovery.md).

## Default roles

| Role | Effort | Tools | Intent |
|------|--------|-------|--------|
| `scout` | low | read, grep, find, ls + mail | Explore and report evidence; read-only |
| `reviewer` | high | read, grep, find, ls + mail | Review with findings and validation; read-only |
| `worker` | medium | read, grep, find, ls, bash, edit, write + mail + `compact_and_continue` | Implement and validate changes |

`compact_and_continue` is supplied by the optional protocol-v2 `pi-compact-warning` worker extension. Without that extension installed the profile entry is inert: Pi ignores unknown tool names and the worker records the omission in its activity log. Read-only roles deliberately exclude it because its honest session-mutating `write` effect would otherwise flip their writability classification. To give a read-only role the compaction handoff anyway, define a custom role/address profile listing it and accept the writable classification.

Nested delegation is not a configurable profile capability.

## Notes

- A single formatted envelope and every complete batch prefix must fit `maxBatchBytes`, the context-safe tool payload budget (currently 48 KB with reserved result overhead), and a conservative selected-model budget of one quarter of `contextWindow - maxTokens` (one quarter of `contextWindow` for providers that keep `maxTokens` equal to `contextWindow`); boundaries never split an envelope. At most 1952 lines are returned by the mail tool. This ensures the same mail remains retrievable through `fetch_emails`; XML escaping counts toward the byte limit.
- `modelPolicy` replaces the entire model-selection policy bullet list in both the main coordinator prompt and every subagent prompt. The default policy is catalog-neutral: it chooses only from the available-model list, honors an explicitly requested available model without silent substitution, and directs exact prospective decisions to `inspect_agent`. The available-model list reflects prospective IDs routable under the current main provider; existing exact bindings can remain usable even when a different provider is preferred.
- Live-session journal maintenance compacts after more than 8192 excess transition events. It also prunes the oldest terminal mail above `maxRetainedEmails`; queued mail, open obligations, reservations, and retained request/reply pairs remain intact. The cap is soft when protected mail alone exceeds it.
- Provider, model catalog, and credential changes require an extension reload; worker runtimes snapshot them at session start.
