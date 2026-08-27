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
- Host credentials, environment variables, network access, symlink policy, and process isolation are not sandboxed by this extension. Worker readiness checks only supported non-secret credential-source equivalence; they neither transfer secrets nor prove universal account identity.
- Read-only role defaults reduce accidental mutation but are not an OS security boundary.
- Pi 0.84.2 direct mutation serialization is best-effort within one Pi runtime. Public-queue dependency tests observe distinct keys for missing targets through symlinked ancestors and for existing hard-link pathnames. The extension has no supported universal interception boundary, adds no global path lock, and parallel writable workers can still create semantic conflicts.
- Durability covers ordinary process crashes with at-least-once delivery; it does not promise sudden-power-loss durability or exactly-once external side effects. A terminal failure leaves every original mail obligation authoritative, and an empty work ledger is not proof that no effect occurred. Possible-effect recovery must reuse the same identity/session/provider binding; do not redelegate that scope while the original obligation remains open unless the user explicitly accepts the duplicate-effect risk and resolves it. Collected replies are only at-most-one live presentation because Pi 0.84.2 has no staged tool-result append receipt; the mail journal can be answered before the collected result is durable.
- Cleanup covers every started Pi 0.84.2 prompt preflight, the trusted AgentSession, its active model/tool promises and listeners, and disposal. Late preflight acceptance is vetoed before an old generation can start a run. pi-subagent is not an OS sandbox: it does not certify or terminate arbitrary OS descendants deliberately detached by a completed command. Do not start background or detached processes unless the task explicitly requires one; when required, report how it is stopped.
- Persistence uses a cooperative lease scoped to one parent-session state namespace. Exact live and `SIGSTOP`ed Linux owners remain protected by strictly validated namespace/boot-ID/PID/start-time/token/timestamp identity. An exact dead owner is reclaimed automatically under a serialized owner transition, but that takeover remains held until normalized registry state commits; incomplete, malformed, publication-gap, or failed-normalization ownership stays fail-closed. The lease is neither a workspace fence nor protection from a malicious same-user process.

Only delegate to models/providers you trust with the project and credentials accessible to Pi. Use external sandboxing for untrusted tasks. Do not market the current `trusted` execution mode as isolation.

## Sensitive data

Mail bodies, subjects, agent activity, usage, and worker session transcripts are persisted beneath `~/.pi/agent/subagents/<parent-session-id>/`. Protect that directory as sensitive data and delete it according to your retention requirements. Provider/session errors copied out of native worker sessions pass through a bounded targeted redaction helper, but this is risk reduction rather than a secrecy guarantee. Native Conversation retains raw provider detail for diagnosis. Configuration semantic fields have explicit UTF-8/count/control bounds; rejected instructions, model policy, tool names, and keys are not echoed in diagnostics, and the coordinator omits derived capability entries only at complete boundaries. These limits are prompt/output safety, not a sandbox or content-trust boundary. Never attach raw state files to public bug reports without reviewing and redacting them, and never put credentials in error messages.

## Security roadmap

Future workspace isolation, subprocess boundaries, and stronger cross-parent coordination are not part of version 0.1.0. Track security work in the repository issue tracker; internal implementation plans are intentionally excluded from the npm artifact.
