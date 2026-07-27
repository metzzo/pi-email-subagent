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
| `maxBatchBytes` | `524288` | 1 B–16 MB | Bytes per worker prompt batch (also the single-email cap) |
| `responseReminderLimit` | `2` | 1–10 | Re-prompts before an agent settling with unanswered mail is marked failed |

## Roles and addresses

```json
{
  "roles": {
    "reviewer": {
      "effort": "high",
      "tools": ["read", "grep", "find", "ls", "send_email", "fetch_emails"],
      "instructions": "Review for correctness; do not modify files."
    }
  },
  "addresses": {
    "worker.release@gpt-5.6-sol.com": {
      "tools": ["read", "bash", "edit", "write", "send_email", "fetch_emails"]
    }
  }
}
```

- A role is selected by the address **name** segment (`<name>.<task-slug>@…`); `addresses` keys are full addresses and override role fields per key.
- Resolution order per field: exact address → role → defaults. Default tools are read-only search plus the two mail tools; `send_email` and `fetch_emails` are always force-included.
- Unknown tool names are dropped at worker start and noted in the agent's activity log.
- Whether an agent is *writable* is derived from its effective tools (`bash`/`edit`/`write`) — never from the role label. [`inspect_agent`](inspect-agent.md) reports the resolved result.
- Layers merge per key: a project role replaces individual fields of the same global role, so a trusted project can widen (or narrow) tools for a role.

## Default roles

| Role | Effort | Tools | Intent |
|------|--------|-------|--------|
| `scout` | low | read, grep, find, ls + mail | Explore and report evidence; read-only |
| `reviewer` | high | read, grep, find, ls + mail | Review with findings and validation; read-only |
| `worker` | medium | read, grep, find, ls, bash, edit, write + mail | Implement and validate changes |

## Notes

- `modelPolicy` replaces the entire model-selection policy bullet list in both the main coordinator prompt and every subagent prompt. The available-model list itself always reflects the live catalog.
- The mail journal compacts into a snapshot automatically once it exceeds 8192 events; this is not configurable.
- Provider, model catalog, and credential changes require an extension reload; worker runtimes snapshot them at session start.
