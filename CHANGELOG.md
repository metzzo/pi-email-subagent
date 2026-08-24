# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Removed mechanical completion replies: only an exact successful `send_email` reply closes a mail obligation, while final assistant text remains session-local and exhausted enforcement leaves requests unanswered.
- Known failed recipients now accept and preserve queued mail without catalog re-resolution, attached-worker routing, implicit replacement, or automatic recovery when a removed exact binding returns; only explicit same-identity restart can resume delivery.
- `canSpawn` now means subagent delegation permission for both known and unknown recipients, defaults false for built-in/unknown profiles and legacy records, and leaves exact replies plus mail to main available.
- Explicitly opted-in child requests are atomic outgoing dependencies: parents park without a run slot or enforcement spin, premature upstream replies are rejected before reservation, exact child results are prioritized, and terminal child failures create one durable sanitized correlated blocker.
- Collected replies now state their narrowed at-most-one live presentation guarantee. A real Pi crash-boundary characterization records that 0.81.1 can commit the mail answer before the wait tool-result entry and exposes no staged post-append receipt, so exactly-once presentation remains fail-closed.
- Inspection now takes pending-reply counts directly from the canonical archive-blocker classifier (including outbound child reservations), and cleanup recovery wording no longer promises automatic release for Pi 0.81.1 restored unknown quarantines.
- Workers now use one extension-start public Pi settings snapshot and a fresh no-write `SettingsManager.fromStorage` per worker, preserving Pi migration/trusted merge behavior while steering, follow-up, effort, resume, and concurrent effort changes cannot write global or project settings.
- New worker identities fail closed before mail acceptance unless parent/worker non-secret credential-source status has supported equivalence (`stored`, matching environment context, or non-command models JSON key); runtime overrides, commands, fallback, mismatches, and indeterminate status require correction and reload without secret resolution or comparison.
- Exact worker API/long-cache compatibility metadata must match the extension-start model snapshot. Deterministic Pi characterization covers `prompt_cache_retention` inclusion/omission and one terminal rejection without model-string exceptions, option stripping, replay, provider switch, or extension retry.
- Provider/session/lifecycle errors now cross one idempotent UTF-8 byte/line/control/bidi/markup-bounded summary boundary with targeted common credential-form redaction; native worker Conversation retains protected raw detail, Activity uses the `Pi agent retry` label, and the broker no longer appends a duplicate terminal cause.
- Abandoned-owner recovery now covers the full durable capability-epoch/legacy migration table, preserves an existing unknown cleanup diagnosis, reconstructs exact inherited holds before ordinary admission, and does not rewrite read-only failed or verified-clean stopped lifecycle facts when quarantine overcommits capacity.
- Process-quiescence and mutation-alias compatibility gates remain explicitly disabled on Pi 0.81.1 pending released authoritative APIs. Public dependency characterization records same-path mutation serialization plus the missing-target symlink-ancestor and existing hard-link key gaps without adding an extension-global path lock.
- Prompt, tool, broker, UI, and operator guidance now share one failure contract: live Pi-managed retries must settle; terminal obligations remain open; possible effects require Work/Conversation review and same-identity/session/provider recovery; same-scope redelegation stays forbidden while the original obligation is open unless the user explicitly accepts and resolves that risk; failed mail queues for restart; unknown process-capable cleanup has no automatic release; every fetched response-required email must be answered; and opted-in parents remain responsible while child dependencies are open.
- Configuration now rejects over-budget role/address collections, tool lists/names, instructions, and model policy at complete semantic boundaries with bounded non-echoing warnings; registry restore enforces matching tool/instruction/activity/diagnostic bounds. The main configured-intent capability display attempts built-in roles first, caps exact overrides and total UTF-8 bytes/lines, omits only complete parsed entries with an exact omitted count, and directs exact decisions to `inspect_agent` without capability hashing.
- Release guidance now requires one clean pushed candidate, complete deterministic validation/package/secret/audit/diff logs, schema-parsed evidence, exact Pi 0.81.1 behavioral authority rather than duck-typing claims, independent post-writer reviews, package/state/sentinel hygiene, and an explicit live/platform not-tested list.
- Real Pi nested-delegation E2E now covers default rejection and opt-in parent parking/resumption. Upstream reply admission joins the exact in-flight child-answer delivery commit before rechecking dependencies, closing the prompt-acceptance/tool-execution race without weakening premature-reply rejection.

## [0.1.0] - 2026-08-23

### Added

- Persistent model-addressed Pi workers coordinated through virtual email.
- Durable at-least-once mail journal with reply reservation/commit/release semantics and crash reconciliation.
- Main coordination tools: `send_email`, `fetch_emails`, `inspect_agent`, `wait_for_replies`, `cancel_request`, and `manage_agent`.
- Live `/agents` dashboard, conversation viewer, usage/cost display, and lifecycle controls.
- Role/address profiles, tool enforcement, spawn control, capacity/rate/queue limits, retention, and configurable model policy.
- Real scripted-provider Pi RPC E2E suite plus optional paid live-provider acceptance.
- Cooperative filesystem lease per persistent parent-session state namespace with owner diagnostics and stale-lock recovery, covered by a real child-process `SIGKILL` E2E; this is not a workspace or security fence.
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
- Active tool calls now disarm only the idle watchdog until the last exact parallel call ends; the finite absolute run deadline remains unchanged. Dead progress forwarding and unused lifecycle timestamps were removed, while start/end idle safety remains intact.
- Stop/restart/archive now require affirmative cleanup confidence instead of treating abort/dispose caller deadlines as cancellation. Cleanup stays pending through real late abort settlement; a failed caller-visible restart releases only to paused and requires another explicit restart.
- Cleanup confidence retains generation-level Bash/process risk after completed calls, and Pi 0.81.1 remains explicitly unknown because its public API exposes no process-quiescence receipt.
- Settlement continuation and pending ownership are exact worker/generation state; lifecycle management invalidates and joins the old continuation before replacement.
- Cleanup-quarantined mail is accepted truthfully, materialized/enqueued with its stable ID, revalidated through mutation-admission epochs, and resumed after the last verified release.
- Timed-out `wait_for_replies` results, tool metadata, coordinator guidance, and documentation now explain that pending requests remain correlated and late replies arrive automatically; immediate keepalive-style rejoins are discouraged while deliberate synchronous rejoins remain supported.
- Identity-capacity failures now distinguish `maxAgents` activation leases from `maxConcurrent` run slots and direct main/downstream callers through explicit reuse, restart, stop, exact cancellation, clean archive, and retry steps without automating destructive actions.
- Isolated workers now load effective trusted Pi retry/provider-retry/transport/timeout settings with Pi's own `SettingsManager`; untrusted project settings remain ignored and Pi defaults are unchanged.
- Final non-retrying assistant errors are committed through the existing worker failure path at full `agent_settled`, after Pi emits any unsuccessful retry-cycle end, so retry activity is preserved before bounded cleanup while the original mail obligation remains open.
- The npm package excludes internal implementation plans and enforces one shared entry-count, tarball-size, required-file, forbidden-path, and package-local Markdown-link policy in local smoke and CI.
- Conversation and persisted-diff readers use the supported `SessionManager.open(...).getBranch()` path instead of Pi test-only parsing exports.
- The Pi RPC E2E client now decodes split UTF-8 safely and rejects malformed or unterminated JSONL stdout records.
- Version 0.1.0 is supported and CI/load-tested against Pi 0.81.1; wildcard host peers do not imply compatibility with untested Pi versions.

### Security

- XML framing escapes peer-controlled content; TUI rendering strips terminal controls.
- State directories/files use restrictive permissions.
- Workers remain trusted collaborators sharing the host Pi process and project workspace; see `SECURITY.md`.
- Mail tail repair now writes a restrictive same-directory temporary journal and atomically replaces the old path, so a pre-rename failure leaves accepted events in the original journal intact; sudden-power-loss durability is still outside the contract.
- Existing namespace directories are repaired to `0700` before locking, and newly persisted owner metadata safely replaces stale metadata at `0600`.
- Direct mutation serialization is documented as best-effort, including upstream missing-target symlink and hard-link alias gaps.

The initial release uses tag `v0.1.0`; subsequent changes remain under Unreleased until the next versioned tag.

[Unreleased]: https://github.com/metzzo/pi-email-subagent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/metzzo/pi-email-subagent/releases/tag/v0.1.0
