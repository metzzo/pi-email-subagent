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
- Generation-bound worker cleanup leases with persisted fail-closed quarantine diagnostics, exact inherited run-slot/capability facts, durable queued-mail preservation, late-settlement observation, and namespace-safe shutdown handoff.
- Linux namespace-owner fencing with boot ID and kernel process-start identity, abandoned-owner recovery, live `SIGSTOP` protection, and sticky writable-generation quarantine before restore.
- Derived identity-lease/run-slot capacity and bounded archive-blocker views across inspection, management, and `/agents`, with explicit fail-closed recovery guidance.
- Pi-managed provider retry start/recovery/end visibility through the existing bounded Activity/current-activity path, plus current-batch effect warnings and same-identity terminal recovery guidance without a new diagnostic schema.
- Durable first-mail provider/model binding intent with exact crash-window recovery, legacy unique migration, bounded binding diagnostics, and additive provider visibility in send/inspect/dashboard surfaces.

### Changed

- Tool string enums now use Google-compatible schemas.
- Tool failures use Pi's native thrown-error contract.
- Mail and joined-reply tool output is bounded to Pi's context-safe byte/line recommendations.
- Conversation rendering collapses mutation arguments and never dumps raw write/replacement content; edit results use bounded patch previews.
- The dashboard and Agents widget label paused, stopped, and archived identities uniformly as `closed`; internal lifecycle/API states remain distinct.
- New identities with globally duplicated model IDs use the current main provider only when it identifies exactly one candidate; existing identities now preserve their persisted exact provider/model across startup, main-model switches, stop/restart, archive/restore, provider removal/reintroduction, and later duplicates without cross-provider substitution.
- Active tool calls now disarm only the idle watchdog until the last exact parallel call ends; the finite absolute run deadline remains unchanged, and tool progress liveness carries no arguments or output.
- Stop/restart/archive now require affirmative cleanup confidence instead of treating abort/dispose caller deadlines as cancellation. Cleanup stays pending through real late abort settlement; a failed caller-visible restart releases only to paused and requires another explicit restart.
- Cleanup confidence retains generation-level Bash/process risk after completed calls, and Pi 0.81.1 remains explicitly unknown because its public API exposes no process-quiescence receipt.
- Settlement continuation and pending ownership are exact worker/generation state; lifecycle management invalidates and joins the old continuation before replacement.
- Cleanup-quarantined mail is accepted truthfully, materialized/enqueued with its stable ID, revalidated through mutation-admission epochs, and resumed after the last verified release.
- Timed-out `wait_for_replies` results, tool metadata, coordinator guidance, and documentation now explain that pending requests remain correlated and late replies arrive automatically; immediate keepalive-style rejoins are discouraged while deliberate synchronous rejoins remain supported.
- Identity-capacity failures now distinguish `maxAgents` activation leases from `maxConcurrent` run slots and direct main/downstream callers through explicit reuse, restart, stop, exact cancellation, clean archive, and retry steps without automating destructive actions.
- Isolated workers now load effective trusted Pi retry/provider-retry/transport/timeout settings with Pi's own `SettingsManager`; untrusted project settings remain ignored and Pi defaults are unchanged.
- Final non-retrying assistant errors are committed through the existing worker failure path at full `agent_settled`, after Pi emits any unsuccessful retry-cycle end, so retry activity is preserved before bounded cleanup while the original mail obligation remains open.

### Security

- XML framing escapes peer-controlled content; TUI rendering strips terminal controls.
- State directories/files use restrictive permissions.
- Workers remain trusted collaborators sharing the host Pi process and project workspace; see `SECURITY.md`.

[Unreleased]: https://github.com/metzzo/pi-email-subagent/compare/HEAD...HEAD
