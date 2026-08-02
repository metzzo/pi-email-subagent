# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Persistent model-addressed Pi workers coordinated through virtual email.
- Durable at-least-once mail journal with reply reservation/commit/release semantics and crash reconciliation.
- Main coordination tools: `send_email`, `fetch_emails`, `inspect_agent`, `wait_for_replies`, and `manage_agent`.
- Live `/agents` dashboard, conversation viewer, usage/cost display, and lifecycle controls.
- Role/address profiles, tool enforcement, spawn control, capacity/rate/queue limits, retention, and configurable model policy.
- Real scripted-provider Pi RPC E2E suite plus optional paid live-provider acceptance.
- Single-writer filesystem lease per persistent parent-session namespace with owner diagnostics and stale-lock recovery, covered by a real child-process `SIGKILL` E2E.
- Initial-delegation lifecycle policies with finite defaults/maxima, durable crash-safe spawn intent, runtime watchdogs, bounded cleanup/shutdown, and inspection/dashboard disclosure.
- Work-first `/agents` telemetry and UI: correlated edit/write outcomes, patch statistics and bounded diffs, unverified shell/custom effects, inspection counters, exact-path active warnings, and session-backed crash recovery.
- Required secret scanning and fail-closed production dependency-license checks with a generated release inventory.

### Changed

- Tool string enums now use Google-compatible schemas.
- Tool failures use Pi's native thrown-error contract.
- Mail and joined-reply tool output is bounded to Pi's context-safe byte/line recommendations.
- Conversation rendering collapses mutation arguments and never dumps raw write/replacement content; edit results use bounded patch previews.
- The dashboard and Agents widget label paused, stopped, and archived identities uniformly as `closed`; internal lifecycle/API states remain distinct.

### Security

- XML framing escapes peer-controlled content; TUI rendering strips terminal controls.
- State directories/files use restrictive permissions.
- Workers remain trusted collaborators sharing the host Pi process and project workspace; see `SECURITY.md`.

[Unreleased]: https://github.com/metzzo/pi-email-subagent/compare/HEAD...HEAD
