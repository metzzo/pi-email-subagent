# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Initial `0.1.0` release candidate (unpublished).

### Changed

- Added bounded protocol-v1 opt-in worker extension factories: ordinary global/project extension discovery remains disabled, declared tools are collision/reserved-name checked and verified after activation, worker lifecycle is explicitly bound in `print` mode, nested AgentSession settlements collapse to one worker settlement, and cleanup aborts compaction and joins full admitted prompt operations before certifying quiescence. This enables `pi-compact-warning` warnings, terminating handoffs, compaction, and steering continuations inside email workers.
- Prepared the public repository surface by removing the internal planning archive from published history, ignoring generated `.test-workspaces` evidence, generalizing exact-owner recovery guidance, and adding a prominent trusted-worker/cost warning.
- The default model-selection policy is now catalog-neutral: it uses only advertised available model IDs, honors explicit available-model requests without silent substitution, and supports complete administrator replacement through `modelPolicy`.
- The exact tested host baseline is Pi 0.84.2 with TypeBox 1.3.7. Startup rejects any other public Pi `VERSION` before extension registration or broker/state construction, while required Pi packages remain wildcard host peers.
- Exact worker request-model matching now includes nested `samplingParams`; after admission, a detached clone is deeply frozen for worker use while provider/runtime-owned catalog models remain mutable.
- `wait_for_replies` keeps its 120-second default and early completion but permits one bounded wait of up to 3600 seconds. Coordination guidance reuses identities only for continuing work in the same feature, worktree, or review-repair cycle.
- The optional paid live-provider helper now waits for final main settlement plus a bounded grace, rejects RPC/tool/extension and canonical namespace inconsistencies, preserves unsafe state, and removes only Pi session/tool-settled namespaces after secret-free evidence is saved and read back.
- Removed mechanical completion replies: only an exact successful `send_email` reply closes a mail obligation, while final assistant text remains session-local and exhausted enforcement leaves requests unanswered.
- Known failed recipients now accept and preserve queued mail without catalog re-resolution, attached-worker routing, implicit replacement, or automatic recovery when a removed exact binding returns; only explicit same-identity restart can resume delivery.
- `canSpawn` is retained only as parsed legacy configuration. Nested response-required delegation is fail-closed disabled for every subagent on Pi 0.84.2; exact replies plus ordinary mail to main remain available.
- Canonical pre-upgrade child journal state remains recoverable without enabling new child admission: queued exact child replies wake their parent, open child requests block parent archival, terminal child failures create one bounded correlated blocker, and exact child cancellation creates one idempotent parent wake.
- Collected replies now state their narrowed at-most-one live presentation guarantee. A real Pi crash-boundary characterization records that 0.84.2 can commit the mail answer before the wait tool-result entry and exposes no staged post-append receipt, so exactly-once presentation remains fail-closed.
- Low-priority mail to busy main now remains broker-queued instead of being pre-owned by a Pi `followUp`. A later `wait_for_replies(collect:true)` can atomically claim a correlated queued reply; otherwise a cancellable one-shot macrotask presents unclaimed mail after public `agent_settled` if the exact session remains idle. Deferred low main mail is bounded across all aliases without charging transient queued high mail, accepted replies survive orderly shutdown races, the serialized main route treats Pi adapter acceptance as its irreversible boundary, finishes commit/failure finalization through orderly shutdown, reports canonical delivered/answered state as success, and never fails an already-delivered answer, high correlated blockers present/end multi-ID waits partial in either collect mode, and active waits that lose presentation ownership omit the duplicate body while later recovery rejoins remain available. Pi 0.84.2 still has no durable `sendMessage` append acknowledgement.
- Inspection now takes pending-reply counts directly from the canonical archive-blocker classifier (including outbound child reservations), and cleanup diagnostics describe only exact-address Pi session/tool settlement.
- Workers now use one extension-start public Pi settings snapshot and a fresh no-write `SettingsManager.fromStorage` per worker, preserving Pi migration/trusted merge behavior while steering, follow-up, effort, resume, and concurrent effort changes cannot write global or project settings.
- New worker identities fail closed before mail acceptance unless parent/worker non-secret credential-source status has supported equivalence (`stored`, matching environment context, or non-command models JSON key); runtime overrides, commands, fallback, mismatches, and indeterminate status require correction and reload without secret resolution or comparison.
- Exact worker API/long-cache compatibility metadata must match the extension-start model snapshot. Deterministic Pi characterization covers `prompt_cache_retention` inclusion/omission and one terminal rejection without model-string exceptions, option stripping, replay, provider switch, or extension retry.
- Provider/session/lifecycle errors now cross one idempotent UTF-8 byte/line/control/bidi/markup-bounded summary boundary with targeted common credential-form redaction; native worker Conversation retains protected raw detail, Activity uses the `Pi agent retry` label, and the broker no longer appends a duplicate terminal cause.
- Worker cleanup now follows the product boundary: one exact lease waits for factory/start, every already-started Pi 0.84.2 prompt preflight, `AgentSession.abort()`/idle, active tool promises/listeners, and disposal. Cleanup vetoes late preflight acceptance at Pi's synchronous callback boundary so an old generation cannot begin a provider/tool run after replacement. Completed ordinary Bash is settled; caller timeouts block only the exact address while late success remains observed; unrelated mutable agents are no longer globally quarantined. Deliberately detached completed-command effects are explicitly outside stop semantics because pi-subagent is not an OS sandbox.
- Cross-platform namespace handling rejects complete Linux-shaped owner records on non-Linux before liveness or lock mutation. An existing PID from incomplete owner metadata is reported only as a fail-closed contender block, never as exact-owner identity or reclaim authority; absent or unknown incomplete owners remain unreclaimable.
- Linux owner recovery treats a successful boot/start mismatch, or signal-0 `ESRCH` after an identity-read failure, as evidence that the recorded exact generation is absent. An identity-read failure alone never authorizes removal: signal-0 success, `EPERM`, or any non-`ESRCH` result blocks as live/unverifiable.
- Linux namespace acquisition now serializes owner inspection/removal/publication and automatically reclaims only a strictly validated complete exact dead boot-ID/PID/start-time owner. Caller namespace paths use the same bounded/control-free predicate before any artifact is created, generated owner records must round-trip through strict validation, and release fails closed if its own owner cannot be recognized. Live and `SIGSTOP`ed owners plus mismatched namespace, malformed/bounded owner fields, missing identity, and ambiguous ownership remain fail-closed without changing the owner or lock. A takeover remains owned until its normalized registry commit succeeds, so initialization failure cannot erase the abandoned-normalization obligation. Dead-owner startup preserves mail/sessions/obligations, marks prior sessions failed/inactive, requires explicit restart, migrates a coherent legacy completed-cleanup shape, and discards legacy operator-release audit fields without claiming Pi-session or OS-process proof.
- Removed cleanup recovery end to end: no `manage_agent recover_cleanup`, confirmation UI module, slash command, online/offline release transition, operator evidence/audit surface, recovery guard, prompt path, or package file remains.
- The mutation-alias compatibility gate remains disabled on Pi 0.84.2. Public dependency characterization records same-path mutation serialization plus the missing-target symlink-ancestor and existing hard-link key gaps without adding an extension-global path lock.
- Prompt, tool, broker, UI, and operator guidance now share one failure contract: live Pi-managed retries and cleanup must settle; terminal obligations remain open; possible effects require Work/Conversation review and same-identity/session/provider recovery; same-scope redelegation stays forbidden while the original obligation is open; failed mail queues for restart; every fetched response-required email must be answered; and background/detached processes require explicit task need plus a reported stop method.
- Configuration now rejects over-budget role/address collections, raw/effective tool lists, tool names, instructions, and model policy at complete semantic boundaries with bounded non-echoing warnings; registry restore enforces matching tool/instruction/activity/diagnostic bounds. Unknown/custom configured tools are conservative writable/effect-capable until exact activation proves otherwise. The main configured-intent display and available-email-model list have independent UTF-8 byte/line/entry budgets, omit only complete entries with exact counts, label partial output, and direct exact decisions to `inspect_agent` without capability hashing.
- Release guidance now requires one clean pushed candidate, complete deterministic validation/package/secret/audit/diff logs, schema-parsed evidence, exact Pi 0.84.2 behavioral authority rather than duck-typing claims, independent post-writer reviews, package/state/sentinel hygiene, and an explicit live/platform not-tested list.
- Real Pi coverage proves nested response-required delegation is rejected even when legacy configuration sets `canSpawn: true`. A direct canonical legacy-journal suite covers queued reply delivery, parent wake, terminal blocker recovery, archive blockers, and cancellation wake without exposing a new delegation path.

### Initial release candidate scope

#### Added

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
- Exact-ID administrative cancellation for intentionally abandoned requests to inactive recipients, with durable actor/reason audit metadata and no fabricated reply.
- Initial-delegation `effort` overrides on `send_email`, including side-effect-free prospective previews through `inspect_agent` and crash-safe spawn-intent recovery.
- Generation-bound worker cleanup leases with persisted fail-closed quarantine diagnostics, exact inherited run-slot/capability facts, durable queued-mail preservation, late-settlement observation, and namespace-safe shutdown handoff.
- Linux namespace-owner fencing with boot ID and kernel process-start identity, abandoned-owner recovery, live `SIGSTOP` protection, and sticky writable-generation quarantine before restore.
- Derived identity-lease/run-slot capacity and bounded archive-blocker views across inspection, management, and `/agents`, with explicit fail-closed recovery guidance.
- Pi-managed provider retry start/recovery/end visibility through the existing bounded Activity/current-activity path, plus current-batch effect warnings and same-identity terminal recovery guidance without a new diagnostic schema.
- Durable first-mail provider/model binding intent with exact crash-window recovery, legacy unique migration, bounded binding diagnostics, and additive provider visibility in send/inspect/dashboard surfaces.

#### Changed

- Tool string enums now use Google-compatible schemas.
- Tool failures use Pi's native thrown-error contract.
- Mail and joined-reply tool output is bounded to Pi's context-safe byte/line recommendations.
- Conversation rendering collapses mutation arguments and never dumps raw write/replacement content; edit results use bounded patch previews.
- The dashboard and Agents widget label paused, stopped, and archived identities uniformly as `closed`; internal lifecycle/API states remain distinct.
- New identities with globally duplicated model IDs use the current main provider only when it identifies exactly one candidate; existing identities now preserve their persisted exact provider/model across startup, main-model switches, stop/restart, archive/restore, provider removal/reintroduction, and later duplicates without cross-provider substitution.
- Active tool calls now disarm only the idle watchdog until the last exact parallel call ends; the finite absolute run deadline remains unchanged. Dead progress forwarding and unused lifecycle timestamps were removed, while start/end idle safety remains intact.
- Stop/restart/archive now require affirmative cleanup confidence instead of treating abort/dispose caller deadlines as cancellation. Cleanup stays pending through real late abort settlement; a failed caller-visible restart releases only to paused and requires another explicit restart.
- Cleanup settlement is scoped to the active Pi session/tool boundary; completed ordinary Bash no longer creates generation-lifetime risk, while deliberately detached completed-command effects remain outside stop semantics.
- Settlement continuation and pending ownership are exact worker/generation state; lifecycle management invalidates and joins the old continuation before replacement.
- Cleanup-quarantined mail is accepted truthfully, materialized/enqueued with its stable ID, revalidated through mutation-admission epochs, and resumed after the last verified release.
- Timed-out `wait_for_replies` results, tool metadata, coordinator guidance, and documentation now explain that pending requests remain correlated and late replies stay durable, while ordinary Pi presentation is only attempted without a durable append receipt; immediate keepalive-style rejoins are discouraged while deliberate synchronous or restart-uncertainty rejoins remain supported.
- Identity-capacity failures now distinguish `maxAgents` activation leases from `maxConcurrent` run slots and direct main/downstream callers through explicit reuse, restart, stop, exact cancellation, clean archive, and retry steps without automating destructive actions.
- Isolated workers now load effective trusted Pi retry/provider-retry/transport/timeout settings with Pi's own `SettingsManager`; untrusted project settings remain ignored and Pi defaults are unchanged.
- Final non-retrying assistant errors are committed through the existing worker failure path at full `agent_settled`, after Pi emits any unsuccessful retry-cycle end, so retry activity is preserved before bounded cleanup while the original mail obligation remains open.
- The npm package excludes internal implementation plans and enforces one shared entry-count, tarball-size, required-file, forbidden-path, and package-local Markdown-link policy in local smoke and CI.
- Conversation and persisted-diff readers use the supported `SessionManager.open(...).getBranch()` path instead of Pi test-only parsing exports.
- The Pi RPC E2E client now decodes split UTF-8 safely and rejects malformed or unterminated JSONL stdout records.
- The `0.1.0` release candidate is CI/load-tested against Pi 0.84.2; wildcard host peers do not imply compatibility with untested Pi versions.

#### Security

- XML framing escapes peer-controlled content; TUI rendering strips terminal controls.
- State directories/files use restrictive permissions.
- Workers remain trusted collaborators sharing the host Pi process and project workspace; see `SECURITY.md`.
- Mail tail repair now writes a restrictive same-directory temporary journal and atomically replaces the old path, so a pre-rename failure leaves accepted events in the original journal intact; sudden-power-loss durability is still outside the contract.
- Existing namespace directories are repaired to `0700` before locking, and newly persisted owner metadata safely replaces stale metadata at `0600`.
- Direct mutation serialization is documented as best-effort, including upstream missing-target symlink and hard-link alias gaps.

The initial release candidate remains unpublished; this changelog claims no release tag or npm publication.
