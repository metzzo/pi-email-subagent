# Security Policy

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** flow under the repository's Security tab to submit a private security advisory. Include the affected commit/version, impact, reproduction steps, and any suggested mitigation.

If private reporting is unavailable, open a minimal public issue requesting a private contact channel. Do not include exploit details, credentials, private prompts, mailbox bodies, or local filesystem paths in a public issue.

We will acknowledge a complete report as soon as practical, coordinate a fix and disclosure window, and credit reporters who want attribution.

## Supported versions

`pi-email-subagent` is currently pre-release. Until the first npm release, only the latest `main` commit is supported. After publication, this table will name supported release lines and security-fix windows.

| Version | Supported |
|---|:---:|
| latest `main` | ✓ |
| unpublished/older snapshots | ✗ |

## Current trust boundary

Extensions execute with the Pi user's permissions. In the current release:

- Workers run in the same Node.js process as the main Pi session.
- Workers share the configured project working directory.
- A writable worker can use its effective `bash`, `edit`, and `write` tools anywhere those host tools permit.
- Host credentials, environment variables, network access, symlink policy, and process isolation are not sandboxed by this extension.
- Read-only role defaults reduce accidental mutation but are not an OS security boundary.
- Pi direct mutation serialization is best-effort. Upstream missing-target symlink paths and hard-link aliases can bypass same-target recognition, and parallel writable workers can still create semantic conflicts.
- Durability covers ordinary process crashes with at-least-once delivery; it does not promise sudden-power-loss durability or exactly-once external side effects.
- Persistence uses a cooperative lease scoped to one parent-session state namespace. An abrupt exit can delay reacquisition for the 10-second stale threshold; the lease reduces accidental concurrent state writers but is neither a workspace fence nor protection from a malicious same-user process.

Only delegate to models/providers you trust with the project and credentials accessible to Pi. Use external sandboxing for untrusted tasks. Do not market the current `trusted` execution mode as isolation.

## Sensitive data

Mail bodies, subjects, agent activity, usage, and worker session transcripts are persisted beneath `~/.pi/agent/subagents/<parent-session-id>/`. Protect that directory as sensitive data and delete it according to your retention requirements. Never attach raw state files to public bug reports without reviewing and redacting them.

## Security roadmap

Future workspace isolation, subprocess boundaries, and stronger cross-parent coordination are not part of version 0.1.0. Track security work in the repository issue tracker; internal implementation plans are intentionally excluded from the npm artifact.
