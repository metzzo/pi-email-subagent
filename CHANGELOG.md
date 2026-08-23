# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Persistent model-addressed Pi workers coordinated through virtual email.
- Durable at-least-once mail journal with reply reservation/commit/release semantics and crash reconciliation.
- Main coordination tools: `send_email`, `fetch_emails`, `inspect_agent`, `wait_for_replies`, `cancel_request`, and `manage_agent`.
- Live `/agents` dashboard, conversation viewer, usage/cost display, and lifecycle controls.
- Role/address profiles, tool enforcement, spawn control, capacity/rate/queue limits, retention, and configurable model policy.
- Real scripted-provider Pi RPC E2E suite plus optional paid live-provider acceptance.
- Single-writer filesystem lease per persistent parent-session namespace with owner diagnostics and stale-lock recovery, covered by a real child-process `SIGKILL` E2E.
- Initial-delegation lifecycle policies with finite defaults/maxima, durable crash-safe spawn intent, runtime watchdogs, bounded cleanup/shutdown, and inspection/dashboard disclosure.
- Work-first `/agents` telemetry and UI: correlated edit/write outcomes, patch statistics and bounded diffs, unverified shell/custom effects, inspection counters, exact-path active warnings, and session-backed crash recovery.
- Required secret scanning and fail-closed production dependency-license checks with a generated release inventory.
- Mechanical completion replies that deliver a successful worker's visible final text when it forgets to call `send_email`, without duplicating explicit replies.
- Exact-ID administrative cancellation for intentionally abandoned requests to inactive recipients, with durable actor/reason audit metadata and no fabricated reply.
- Initial-delegation `effort` overrides on `send_email`, including side-effect-free prospective previews through `inspect_agent` and crash-safe spawn-intent recovery.

### Changed

- Tool string enums now use Google-compatible schemas.
- Tool failures use Pi's native thrown-error contract.
- Mail and joined-reply tool output is bounded to Pi's context-safe byte/line recommendations.
- Conversation rendering collapses mutation arguments and never dumps raw write/replacement content; edit results use bounded patch previews.
- The dashboard and Agents widget label paused, stopped, and archived identities uniformly as `closed`; internal lifecycle/API states remain distinct.
- When an enabled model ID exists under multiple providers, email routing prefers the main session's current provider and remains fail-closed when that does not uniquely resolve the model.
- Active tool calls now disarm only the idle watchdog until the last exact parallel call ends; the finite absolute run deadline remains unchanged, and tool progress liveness carries no arguments or output.

### Security

- XML framing escapes peer-controlled content; TUI rendering strips terminal controls.
- State directories/files use restrictive permissions.
- Workers remain trusted collaborators sharing the host Pi process and project workspace; see `SECURITY.md`.

[Unreleased]: https://github.com/metzzo/pi-email-subagent/compare/HEAD...HEAD
