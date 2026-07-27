# pi-email-subagent

Persistent parallel Pi subagents coordinated through virtual email.

## Install

```bash
pi install /absolute/path/to/pi-subagent
```

For development in this repository, `.pi/extensions/pi-email-subagent.ts` loads the source directly. On Pi 0.81.1, run `/reload-runtime` manually after changes; extension-originated slash messages cannot safely defer that command.

## Tools

```text
send_email(to, subject, message, priority)
fetch_emails()
inspect_agent(address)
wait_for_replies(request_ids, timeout_seconds, collect)
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

High-priority mail steers a running recipient at the next safe boundary. Low-priority mail waits until the recipient settles. A worker that settles with unanswered requests is automatically prompted to respond.

`send_email` returns the allocated request/correlation ID, exact expected reply subject, effective recipient role/tools/model, and delivery state. `inspect_agent` previews the same effective profile without spawning. `wait_for_replies` joins several delegated requests and can collect their replies without separate model turns. `manage_agent` is main-thread-only and supports `stop`, `restart`, `archive`, and `clear_failure`; workers continue to receive only the two email tools.

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
- `/agents clear-failure <address>`
- `/agents effort <address> <off|minimal|low|medium|high|xhigh|max>`

The dashboard shows status, model, effort, recent text/tool activity, usage, failures, and unanswered mail without exposing hidden thinking. Select an agent and press `Ctrl+O` to open its complete recorded conversation; the viewer refreshes while the agent appends, and arrows or Page Up/Page Down scroll it. Press `Ctrl+O` or Escape to close. In main session history, `Ctrl+O` expands `send_email` results and incoming email cards with a bounded recent conversation preview plus directions to the full viewer, avoiding duplicate unbounded transcripts.

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

Resolution order is exact address, role name, then defaults. The address always controls the model. Effective configured tools—not role labels—determine whether a recipient is writable.

Provider definitions, the model catalog, and persistent credentials are snapshotted for workers when the extension starts. Provider/model/auth configuration changes take effect after an extension reload; workers are not continuously synchronized. Runtime-only credentials that are absent from Pi's persistent credential store cannot be transferred to an isolated worker; persist them before delegating worker tasks.

## Persistence and limits

State is stored under `~/.pi/agent/subagents/<parent-session-id>/`. Mail is journaled before acceptance and worker sessions are resumed after reload. The append-only mail journal is compacted into a snapshot once it grows past 8192 events. Defaults allow eight active registered identities and four concurrently running workers. Clean stopped/idle identities can be archived without deleting their sessions or mail; archived identities do not consume active capacity and restore their persistent context when restarted or mailed again.

Reply obligations use durable reservation, delivery, commit, and release transitions: concurrent replies cannot both claim one request, and a failed reply delivery reopens it. Delivery across process-crash recovery is at least once, not exactly once. Stable email IDs let workers recognize retries and avoid repeating completed side effects. Durability targets ordinary process crashes, not sudden power loss.

Workers are trusted collaborators and may delegate. They share the project working directory in this version; host sandboxing, credential isolation, path restrictions, network policy, and protection from malicious same-user processes are external responsibilities. Prefer effectively read-only roles when running several agents; parallel writable agents can make semantic conflicts even though Pi serializes direct file mutations.

Provider/catalog changes require extension reload. Compatibility is limited to the tested Pi `>=0.81.1 <0.82.0` line.

See `plans/pi-email-subagent-extension.md` for the design and `plans/end-to-end-test-plan.md` for validation.
