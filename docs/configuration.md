# Configuration

Tool behavior is governed by `subagents.json`, loaded in two layers:

1. **Global**: `~/.pi/agent/subagents.json` — always read.
2. **Project**: `<config-dir>/subagents.json` (normally `.pi/subagents.json`; discovered via Pi's `CONFIG_DIR_NAME`) — read only when the project is trusted.

Project values merge over global values, which merge over the defaults below. Invalid values produce a startup warning and fall back. Changes apply on session start / extension reload.

## Limits

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
| `maxQueuedMessages` | `256` | 1–10000 | Queued inbound per recipient |
| `maxQueuedBytes` | `4194304` | 1 B–64 MB | Queued inbound bytes per recipient |
| `maxBatchMessages` | `32` | 1–1024 | Emails per worker prompt batch |
| `maxBatchBytes` | `524288` | 1 B–512 KB | Formatted bytes per worker delivery batch; fetch/tool output is independently capped by Pi's 50 KB / 2000-line recommendation |
| `maxRetainedEmails` | `10000` | 1–1000000 | Soft cap for retained envelopes; open obligations are never pruned |
| `responseReminderLimit` | `2` | 1–10 | Re-prompts before an agent settling with unanswered mail is marked failed |

`maxAgents` and `maxConcurrent` are intentionally separate. `maxAgents` counts current activation leases for persistent identities, including stopped identities and cleanup quarantines. `maxConcurrent` counts current run slots; work can queue for a run slot while its identity already holds a lease. Waiting for run concurrency or stopping a worker does not free identity capacity. A successful clean archive is the normal explicit lease release.

`inspect_agent` and `/agents` derive current used/limit values directly from the broker's authoritative lease sets. These capacity views are not written to `registry.json` and do not change either default (`8` identities, `4` runs).

## Lifecycle watchdogs

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

`abortTimeoutMs` and `disposeTimeoutMs` bound caller responsiveness, not the lifetime of the underlying cleanup Promise. Missing either deadline leaves cleanup registered and observed. Routing detaches, but capacity/address ownership stays quarantined until a structured verified report; unknown cleanup is persisted and survives restart. The defaults are not process-quiescence guarantees, and increasing them does not create cancellation. See [lifecycle.md](lifecycle.md) for the Pi 0.81.1 active-tool receipt limit.

For the six worker fields, `lifecycleMaxima` is the administrative ceiling for initial delegation overrides and resolution is field-by-field: initial request → exact address → role → global `lifecycle`. Role and address objects accept those six worker lifecycle fields. `brokerShutdownTimeoutMs` and its maximum are global administrator-only configuration; broker shutdown is never delegated or resolved per worker. See [lifecycle.md](lifecycle.md).

## Roles and addresses

```json
{
  "roles": {
    "reviewer": {
      "effort": "high",
      "tools": ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
      "instructions": "Review for correctness; do not modify files.",
      "canSpawn": false,
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
- `canSpawn` (default `true`) controls whether an agent may send to an unknown address and thereby create a new identity. Spawn-disabled agents get an actionable error and may still reuse existing addresses, reply, and mail main; their system prompt states the restriction. Main is never spawn-restricted.
- Unknown tool names are dropped at worker start and noted in the agent's activity log.
- Whether an agent is *writable* is derived from its effective tools (`bash`/`edit`/`write`) — never from the role label. [`inspect_agent`](inspect-agent.md) reports the resolved result and can preview an initial effort override without spawning.
- Layers merge per key: a project role replaces individual fields of the same global role, so a trusted project can widen (or narrow) tools for a role.

## Provider/model routing

The email domain remains a model ID. Provider choice is not configured in `subagents.json` and there is no provider override argument:

- a new globally unique model ID resolves directly;
- a new duplicate ID resolves only when the current main provider owns exactly one candidate;
- a main provider switch changes prospective selection immediately, including switches whose model ID (and therefore main address text) is unchanged;
- an existing identity always resolves its persisted exact provider/model; and
- a missing exact tuple remains unavailable and is never replaced by a same-ID candidate from another provider.

The first accepted mail for a new identity journals exact provider/model binding intent with effort/lifecycle intent. Legacy accepted mail without that field migrates only when the model ID has one global candidate; duplicates remain unavailable because the original provider cannot be inferred. Provider definitions and the worker catalog are still immutable extension-start snapshots, so removal/reintroduction and metadata changes take effect only after reload. See [Provider-aware durable model routing](provider-aware-model-routing.md).

## Pi retry and transport settings

Provider retry/transport policy is not duplicated in `subagents.json`. Each isolated worker loads Pi's ordinary effective `settings.json` values with the same `cwd`, agent directory, and project-trust decision as the parent runtime:

- global retry/transport settings always apply;
- `.pi/settings.json` overrides apply only for a trusted project;
- untrusted project settings are ignored;
- worker steering/follow-up modes and persisted effort are the only in-memory overrides made by this extension; and
- Pi defaults are not raised. `retry.provider.maxRetries` remains `0` unless the user explicitly configures it.

The relevant Pi keys are `retry.enabled`, `retry.maxRetries`, `retry.baseDelayMs`, `retry.provider.timeoutMs`, `retry.provider.maxRetries`, `retry.provider.maxRetryDelayMs`, `transport`, `httpIdleTimeoutMs`, and `websocketConnectTimeoutMs`. A global/project settings load error is reported by scope in bounded worker Activity without copying file content. See [Provider retry visibility and recovery](provider-retry-recovery.md).

## Default roles

| Role | Effort | Tools | Intent |
|------|--------|-------|--------|
| `scout` | low | read, grep, find, ls + mail | Explore and report evidence; read-only |
| `reviewer` | high | read, grep, find, ls + mail | Review with findings and validation; read-only |
| `worker` | medium | read, grep, find, ls, bash, edit, write + mail | Implement and validate changes |

All default roles may spawn; set `canSpawn: false` on read-only roles to prevent fan-out and unplanned token spend.

## Notes

- A single formatted envelope must fit the smaller of `maxBatchBytes` and the context-safe tool payload budget (currently 48 KB with reserved result overhead), and at most 1952 lines. This ensures the same mail remains retrievable through `fetch_emails`; XML escaping counts toward the byte limit.
- `modelPolicy` replaces the entire model-selection policy bullet list in both the main coordinator prompt and every subagent prompt. The available-model list reflects prospective IDs routable under the current main provider; existing exact bindings can remain usable even when a different provider is preferred.
- Live-session journal maintenance compacts after more than 8192 excess transition events. It also prunes the oldest terminal mail above `maxRetainedEmails`; queued mail, open obligations, reservations, and retained request/reply pairs remain intact. The cap is soft when protected mail alone exceeds it.
- Provider, model catalog, and credential changes require an extension reload; worker runtimes snapshot them at session start.
