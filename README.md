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
send_email(to, subject, message, priority, lifecycle?)
fetch_emails()
inspect_agent(address)
wait_for_replies(request_ids, timeout_seconds, collect)
cancel_request(request_id, reason)
manage_agent(address, action)
```

Sending to an unknown valid address creates a persistent worker. Addresses use:

```text
<name>.<task-slug>@<registered-model>.com
```

The main thread is `main@<model>.com`. Model IDs are validated against Pi's available catalog. Replies must copy the exact subject returned by `fetch_emails()`:

```text
Re: [mail-id] Original subject
```

High-priority mail steers a running recipient at the next safe boundary. Low-priority mail waits until the recipient settles. If a successful worker finishes with visible final text but forgets `send_email`, the broker mechanically sends that text through the exact durable reply protocol; truly silent runs are automatically prompted to respond.

`send_email` returns the allocated request/correlation ID, exact expected reply subject, effective recipient role/tools/model, finite persisted lifecycle policy, and delivery state. `inspect_agent` previews the same effective profile without spawning. `wait_for_replies` joins several delegated requests and can collect their replies without separate model turns. `cancel_request` durably closes one intentionally abandoned obligation to an inactive recipient, recording the actor and reason without fabricating a reply. `manage_agent` is main-thread-only and supports `stop`, `restart`, `archive`, and `clear_failure`; workers continue to receive only the two email tools.

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

Profile resolution order is exact address, role name, then defaults. Initial lifecycle fields resolve initial request, exact address, role, then finite global defaults, subject to administrator-configured maxima. Later mail cannot mutate a persisted policy; archived restoration preserves it. The address always controls the model. Effective configured tools—not role labels—determine whether a recipient is writable.

Provider definitions, the model catalog, and persistent credentials are snapshotted for workers when the extension starts. Provider/model/auth configuration changes take effect after an extension reload; workers are not continuously synchronized. Runtime-only credentials that are absent from Pi's persistent credential store cannot be transferred to an isolated worker; persist them before delegating worker tasks.

## Persistence and limits

State is stored under `~/.pi/agent/subagents/<parent-session-id>/`. An OS-visible lease permits only one live broker to own a parent-session namespace; a second process receives the recorded PID/acquisition time, and an abruptly abandoned lease becomes recoverable after 10 seconds. Mail is journaled before acceptance and worker sessions are resumed after reload. The initial mail contains durable lifecycle spawn intent and the registry record is saved before worker/provider startup; startup reconciles queued mail whose recipient record was not persisted before a crash without widening its accepted policy. Run, active-run stall, prompt, spawn, abort, dispose, and global shutdown deadlines are finite. Broker shutdown is bounded, but retains namespace ownership when timed-out late mutation cannot be proven quiescent; see [`docs/lifecycle.md`](docs/lifecycle.md). The journal is maintained during live sessions: excess transitions are compacted into a snapshot and the oldest terminal envelopes above `maxRetainedEmails` are pruned, while every open obligation and retained request/reply pair is preserved. Defaults allow eight active registered identities and four concurrently running workers. Clean stopped/idle identities can be archived without deleting their sessions or mail; archived identities do not consume active capacity and restore their persistent context when restarted or mailed again.

Reply obligations use durable reservation, delivery, commit, release, and explicit administrative-cancellation transitions: concurrent replies cannot both claim one request, a failed reply delivery reopens it, and abandoned work can be closed with an audited reason only after its recipient is inactive. Delivery across process-crash recovery is at least once, not exactly once. Stable email IDs let workers recognize retries and avoid repeating completed side effects. Durability targets ordinary process crashes, not sudden power loss.

Workers are trusted collaborators and may delegate. They share the project working directory in this version; host sandboxing, credential isolation, path restrictions, network policy, and protection from malicious same-user processes are external responsibilities. Prefer effectively read-only roles when running several agents; parallel writable agents can make semantic conflicts even though Pi serializes direct file mutations.

Provider/catalog changes require extension reload. The current deterministic and live acceptance evidence targets Pi 0.81.1 on Node 22.19.0. Pi core packages are host-provided wildcard peers as required by Pi package guidance; that avoids duplicate runtimes but is not a claim that untested Pi versions are compatible. CI compatibility coverage will expand before 1.0.

## Development and support

- `npm run validate`: TypeScript, production dependency-license policy, all deterministic tests, real scripted-provider Pi RPC E2E, and a clean packed-artifact install/load smoke.
- `npm run check:secrets`: local Gitleaks 8.30.1 scan using the same policy as required CI; see [`docs/release-security-checks.md`](docs/release-security-checks.md).
- `CONTRIBUTING.md`: development and pull-request expectations.
- `SECURITY.md`: vulnerability reporting, sensitive data, and the current trusted-worker threat boundary.
- `CHANGELOG.md`: release changes.
- `plans/top-1-percent-plan.md`: prioritized release, safety, isolation, product, and scale roadmap.

See `plans/pi-email-subagent-extension.md` for the design and `plans/end-to-end-test-plan.md` for validation.
