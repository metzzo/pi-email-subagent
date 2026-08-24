# pi-email-subagent

Persistent parallel Pi subagents coordinated through virtual email.

## Install

The package is currently an unpublished `0.1.0` release candidate. Install a trusted checkout by absolute path:

```bash
pi install /absolute/path/to/pi-email-subagent
```

After the first npm release, the canonical command will be:

```bash
pi install npm:pi-email-subagent
```

For development in this repository, `.pi/extensions/pi-email-subagent.ts` loads the source directly. On Pi 0.81.1, run `/reload-runtime` manually after changes; extension-originated slash messages cannot safely defer that command.

## Tools

```text
send_email(to, subject, message, priority, effort?, lifecycle?)
fetch_emails()
inspect_agent(address)
wait_for_replies(request_ids, timeout_seconds, collect)
cancel_request(request_id, reason)
manage_agent(address, action)
```

Sending to an unknown valid address creates a persistent worker. The first send
may include `effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" |
"max"`; that value overrides configured defaults for the new identity and is
persisted. Later mail cannot mutate it. Addresses use:

```text
<name>.<task-slug>@<registered-model>.com
```

The main thread is `main@<model>.com`. The domain is a model ID, not a provider ID. A globally unique model ID is selected directly for a new identity; duplicates use the current main provider only when it identifies exactly one candidate. The first accepted mail persists that exact provider/model binding. Existing, failed, stopped, archived, and restored identities always preserve their original binding across main-model changes and later duplicate IDs; unavailable bindings are never silently substituted. Ordinary mail to a known failed identity is accepted and queued under its stable ID without catalog re-resolution or implicit restart; only explicit same-identity restart can resume it. See [provider-aware durable model routing](docs/provider-aware-model-routing.md). Replies must copy the exact subject returned by `fetch_emails()`:

```text
Re: [mail-id] Original subject
```

High-priority mail steers a running recipient at the next safe boundary. Low-priority mail waits until the recipient settles. Only an exact successful `send_email` reply closes an obligation; visible final assistant text is never copied across mail IDs. A worker that settles with unanswered mail is prompted to send exact replies, and exhausted enforcement marks it failed without answering any request.

`send_email` returns the allocated request/correlation ID, exact expected reply subject, effective recipient role/tools/provider/model, finite persisted lifecycle policy, and delivery state. `inspect_agent` previews the same effective profile without spawning and reports derived identity-lease capacity separately from run concurrency. `wait_for_replies` opens a bounded collection window; after a pending timeout, requests remain correlated and late replies trigger main delivery automatically, so no keepalive-style rejoin is needed. Collection is at-most-one live presentation: Pi 0.81.1 has no staged tool-result append receipt, so Conversation/mail inspection plus the stable request ID is the recovery path for a crash between mail answer commit and result persistence. `cancel_request` durably closes one intentionally abandoned obligation to an inactive recipient, recording the actor and reason without fabricating a reply. `manage_agent` is main-thread-only and supports `stop`, `restart`, `archive`, and `clear_failure`; stop retains the identity lease, while a successful clean archive releases it. Workers continue to receive only the two email tools. See the [safe capacity recovery order](docs/manage-agent.md#safe-identity-capacity-recovery).

Pi remains the sole owner of automatic provider retries. **Pi agent retry** start/recovery/end is shown through the bounded Activity path without failing the worker or changing mail; provider/SDK request attempts remain a separate lower layer. A final non-retrying error uses one bounded sanitized failure/alert boundary and keeps every original mail obligation open, while the native worker Conversation retains protected provider detail. Before explicit same-identity/session/provider recovery, inspect current-batch Work and native Conversation because effects may exist; an empty work ledger is not proof of pre-tool failure. Do not redelegate the same possible-effect scope while its original obligation remains open unless the user explicitly accepts that risk and resolves the original obligation. Failed recipients keep accepted mail queued for explicit restart. Process-capable cleanup quarantine has no automatic release on Pi 0.81.1. See [provider retry visibility and recovery](docs/provider-retry-recovery.md).

## Model selection

- Use `k3` (`k3.com` in an email address) for challenging, web-development-related, or creative tasks.
- Use `gpt-5.6-sol` (`gpt-5.6-sol.com`) for very difficult, complicated, or high-reasoning-dependent tasks. This higher threshold takes precedence over `k3`.
- Use `gpt-5.6-terra` (`gpt-5.6-terra.com`) only for very simple, fully explicit tasks that are not open to interpretation.
- Do not use any other model unless the user explicitly requests that specific model.
- When classification is ambiguous, do not use Terra if interpretation is required; use K3 unless the Sol threshold is clearly met. If the preferred model is unavailable, report that instead of silently substituting another model.

## UI

- `/agents` or `Ctrl+Shift+A`: open the live dashboard.
- `/agents stop <address>`
- `/agents restart <address>`
- `/agents archive <address>`
- `/agents cancel <request-id> <reason>`
- `/agents clear-failure <address>`
- `/agents effort <address> <off|minimal|low|medium|high|xhigh|max>`

The work-first dashboard distinguishes running edit/write intent, successful and failed built-in mutations, unverified shell/custom effects, and collapsed inspection counters. Successful edits show file/patch statistics; writes show UTF-8 size and line count without retaining raw content. Exact-path simultaneous mutation intent is warned on both agents. `Enter` opens Work/Activity/Inbox/Profile tabs, `d` opens a bounded edit diff, and `Ctrl+O` opens the visible recorded conversation (thinking and bounded/hidden mutation bodies remain omitted). See [the dashboard guide](docs/agents-dashboard.md) for navigation, confidence limits, recovery, and privacy.

## Configuration

Global: `~/.pi/agent/subagents.json`

Trusted project override: `<Pi config dir>/subagents.json` (normally `.pi/subagents.json`; the extension uses Pi's `CONFIG_DIR_NAME` for rebranded distributions)

```json
{
  "defaultEffort": "medium",
  "modelPolicy": "- Use model ID `k3` ... (override the model selection policy section of every agent prompt)",
  "maxAgents": 8,
  "maxConcurrent": 4,
  "maxMailsPerMinute": 60,
  "maxMailsPerSenderPerMinute": 30,
  "maxQueuedMessages": 256,
  "maxQueuedBytes": 4194304,
  "maxBatchMessages": 32,
  "maxBatchBytes": 524288,
  "maxRetainedEmails": 10000,
  "lifecycle": {
    "spawnTimeoutMs": 30000,
    "promptAcceptanceTimeoutMs": 30000,
    "runTimeoutMs": 14400000,
    "idleTimeoutMs": 900000,
    "abortTimeoutMs": 10000,
    "disposeTimeoutMs": 10000,
    "brokerShutdownTimeoutMs": 60000
  },
  "roles": {
    "scout": {
      "effort": "low",
      "tools": ["read", "grep", "find", "ls", "send_email", "fetch_emails"]
    },
    "worker": {
      "effort": "high",
      "tools": ["read", "grep", "find", "ls", "bash", "edit", "write", "send_email", "fetch_emails"]
    }
  }
}
```

Profile resolution order is exact address, role name, then defaults. Initial
effort resolves initial request, exact address, role, then `defaultEffort`;
initial lifecycle fields resolve initial request, exact address, role, then
finite global defaults, subject to administrator-configured maxima. Later mail
cannot mutate either persisted value; archived restoration preserves both. An
address locates one persistent identity; its exact provider/model binding is
durable outside the model-ID-only address. Effective configured tools—not role
labels—determine whether a recipient is writable. Parsed configuration is capped at 64 roles, 256 exact addresses, 128 effective tools per profile, 100 UTF-8 bytes per complete tool name, and 16 KiB each for complete instructions/model policy; oversized/control-bearing semantic fields are rejected whole without echoing their raw content. The coordinator's derived configured-intent display is separately capped at 8 KiB / 64 lines, attempts built-in roles first, displays at most 24 exact overrides, and omits only complete entries with a parsed-entry count. It never shortens semantic fields or substitutes capability hashes; use `inspect_agent` for exact live/prospective capability.

Provider definitions, exact model compatibility metadata, and non-secret credential-source status are snapshotted when the extension starts. Workers enforce **supported credential-source equivalence**: matching stored credentials through the same explicit `auth.json` path, matching environment source context in the same process, and matching non-command `models.json` keys are supported. Runtime overrides, command resolution, provider fallback, mismatches, and indeterminate/unconfigured status fail closed. The extension never resolves, compares, copies, fingerprints, logs, or transfers credential material, and this source policy is not a universal account-identity proof. A new identity fails readiness before mail acceptance; ordinary mail to a known failed identity still queues without readiness work, and explicit same-identity restart performs the check. Provider/model/auth-source changes require extension reload.

At extension start, one file-backed Pi settings manager loads global `settings.json` plus trusted project `.pi/settings.json`; load errors are reported once by scope. Its public global/project documents seed a fresh no-write `SettingsManager.fromStorage(...)` for each worker, so Pi still owns migration and nested merge behavior while worker steering/follow-up/effort setters cannot write shared defaults. Retry, provider retry, transport/timeouts, compaction, branch summary, shell/resource paths, and thinking budgets retain Pi's effective trusted behavior. The extension does not raise Pi defaults or enable provider/SDK retries.

Long prompt-cache retention is owned by Pi/provider model metadata, not worker settings. With long retention selected, Pi 0.81.1 emits `prompt_cache_retention: "24h"` only when effective model compatibility allows it; an unsupported endpoint must publish `compat.supportsLongCacheRetention: false` (or correct upstream metadata) and then reload. The extension has no model-string table and never strips the option and replays a rejected request.

Provider/session errors crossing into registry, Activity, work-ledger, UI, or main alerts pass through one UTF-8 byte/line/control/markup-bounded summary with targeted common credential-form redaction. Raw assistant provider errors remain only in the native worker session Conversation. This redaction is bounded risk reduction, not a secrecy guarantee; do not put credentials in error text or publish raw state.

## Persistence and limits

State is stored under `~/.pi/agent/subagents/<parent-session-id>/`. A cooperative filesystem lease reduces accidental concurrent state writers within one parent-session namespace; it is not a workspace or security fence. On Linux, boot ID plus kernel process-start identity prevents a stale mtime from taking that cooperative lease from an exact live or `SIGSTOP`ed owner; after exact owner death and the 10-second lock threshold, takeover is marked abandoned and prior mutation-capable spawning/activated epochs or raw legacy writable evidence become sticky unknown cleanup before restoration, while verified-clean and clean archived evidence is not widened. Platforms without this kernel fence allow clean ownership but fail closed on abandoned takeover. Mail is journaled before acceptance and worker sessions are resumed after reload. The initial mail contains durable provider/model, lifecycle, and effort spawn intent, and the registry record is saved before worker/provider startup; startup reconciles queued mail whose recipient record was not persisted before a crash without selecting again or widening its accepted policy. Run, active-run stall, prompt, spawn, abort, dispose, and global shutdown deadlines are finite. Known in-flight tools disarm only the idle/stall timer; the absolute run deadline stays armed, and the last parallel tool end starts a fresh idle interval. Bash's optional per-call `timeout` can provide a smaller shell-specific bound. Worker teardown is owned by one generation-bound cleanup lease: routing detaches immediately, but deadline expiry does not cancel cleanup or release capacity. Pending/unknown cleanup blocks restart, archive, failure clearing, and new mutable scheduling while accepted mail remains durably queued and is resumed after the last verified release. A caller-visible failed restart never creates a hidden late replacement; another explicit restart is required. Pi 0.81.1 has no public session/generation process-tree quiescence receipt, so the integration gate remains disabled and any generation that ran Bash stays fail-closed even after the call completed and the active-tool map is empty. One Linux E2E observes a same-group parent+descendant topology terminate, while another observes a surviving redirected background heartbeat after completed Bash; neither is generic proof, and no Windows containment claim is made. Broker shutdown is bounded, but retains namespace ownership when timed-out late mutation cannot be proven quiescent; see [`docs/lifecycle.md`](docs/lifecycle.md). The journal is maintained during live sessions: excess transitions are compacted into a snapshot and the oldest terminal envelopes above `maxRetainedEmails` are pruned, while every open obligation and retained request/reply pair is preserved. Defaults allow eight active registered identities and four concurrently running workers. Clean stopped/idle identities can be archived without deleting their sessions or mail; archived identities do not consume active capacity and restore their persistent context when restarted or mailed again.

Reply obligations use durable reservation, delivery, commit, release, and explicit administrative-cancellation transitions: concurrent replies cannot both claim one request, a failed reply delivery reopens it, and abandoned work can be closed with an audited reason only after its recipient is inactive. Delivery across process-crash recovery is at least once, not exactly once. Stable email IDs let workers recognize retries and avoid repeating completed side effects. Durability targets ordinary process crashes, not sudden power loss.

Workers are trusted collaborators, but subagent delegation is disabled by default for built-in and unknown roles. The compatibility key `canSpawn: true` explicitly permits response-required delegation to known or unknown subagents; exact replies and mail to main remain allowed without it. Opted-in child requests durably park the parent without consuming a run slot or enforcement attempts, reject premature upstream replies atomically, and resume on the exact child reply or a sanitized idempotent terminal-child blocker. The parent remains responsible for its upstream request and cannot answer it while any child dependency is open. Workers share the project working directory in this version. Cleanup quarantine coordinates only workers owned by one parent broker; it is not project-wide or cross-parent workspace isolation. Host sandboxing, credential isolation, path restrictions, network policy, cross-parent coordination, and protection from malicious same-user processes are external responsibilities. Prefer effectively read-only roles when running several agents. Pi 0.81.1 direct mutation serialization is best-effort within one Pi runtime: public-queue characterization confirms same-path serialization but distinct keys for missing targets through symlinked ancestors and for existing hard-link pathnames. The extension adds no universal alias/path lock or cross-parent project lease, and parallel writable agents can still create semantic conflicts.

Provider/catalog changes require extension reload. Version 0.1.0 supports Pi 0.81.1 on Node 22.19.0; that is the only Pi version pinned in CI and the packed-artifact load smoke. Startup checks the required public feature surface and reports missing symbols, but feature presence is not a cross-version compatibility guarantee. Pi core packages remain host-provided wildcard peers as required by Pi package guidance, which avoids duplicate runtimes without claiming compatibility with untested Pi versions.

## Development and support

- `npm run validate`: TypeScript, production dependency-license policy, all deterministic tests, real scripted-provider Pi RPC E2E, and a clean packed-artifact install/load smoke.
- `npm run check:secrets`: local Gitleaks 8.30.1 scan using the same policy as required CI; see [`docs/release-security-checks.md`](docs/release-security-checks.md).
- `CONTRIBUTING.md`: development and pull-request expectations.
- `SECURITY.md`: vulnerability reporting, sensitive data, and the current trusted-worker threat boundary.
- `CHANGELOG.md`: release changes and the `v0.1.0` initial-tag strategy.
