# Mechanistic subagent UX — approved plan

Status: approved for implementation; not implemented by this document.
Base: main `17febc8`. Worktree branch: `feat/mechanistic-ux`.

## Goal and observed baseline

Make registered Python programs easy to discover and run without a dispatcher
LLM, repeated setup, or verbose model-facing receipts. Reuse the production
broker, mail journal, scheduler, capacity, lifecycle, UI, and Python helper.

The actual CI-status check created a temporary program/configuration and a
separate Pi main dispatcher. Its native session recorded three assistant
responses and 12,369 total tokens including 7,296 cached input tokens (4,718
uncached input, 355 output). The Python identity itself used no model. These
are dispatcher measurements, not the total cost of the surrounding conversation.

## Complete approved scope

1. **Register useful programs once.** Ship a reusable, read-only CI-status
   program. Default to the repository and current commit in the trusted registered
   cwd; accept an explicit commit when needed. Report the exact commit checked.
   Registration stays an operator-approved global/trusted-project configuration,
   not a mail/tool API. No per-check script rewriting or temporary project setup.
2. **Direct invocation.** Add `/agents run ci.main-status {}` through the existing
   `/agents` surface and broker acceptance path. Preserve the explicit program
   and task context; one invocation remains one accepted mail/job ID. Support
   interactive and headless Pi, with useful visible/structured output. A direct
   command must not call a model to dispatch, show progress, or deliver its
   automatic terminal outcome. Headless execution waits finitely for its own
   result/delivery before exiting; it must not exit early or kill successful work.
   Agent-initiated `send_email` remains supported with its ordinary completion
   notification. This is not a new tool, transport, broker, scheduler, or daemon.
3. **Discovery.** Show registered programs and a short description. Provide
   bounded input examples on inspection, not a dump of every program's manual in
   every model turn. Remove duplicated mechanistic instructions from system
   prompts and tool descriptions. Keep registration/binding authority unchanged.
4. **Concise results.** Acceptance shows the job ID and actual state/uncertainty.
   Completion leads with the useful observation and link, plus runtime or cleanup
   warnings when present. Full reports, stderr, artifacts, and lifecycle details
   stay durable and accessible through expanded inspection. Never hide failed
   admission, uncertain acceptance, quarantine, or no-replay recovery guidance.
   Distinguish a completed CI observation from a passing CI run.
5. **Verification.** Exercise real Python and fresh real Pi commands, headless
   completion, failure, stop, restore, and ownership/capacity races. Prove zero
   model-generation calls for direct CI/status commands, including automatic
   completion. Measure before/after prompt, tool, receipt, and outcome sizes;
   label bytes versus model-reported tokens honestly. Do not invent a savings
   percentage. Preserve coverage gates, packaging checks, and existing LLM mail
   semantics. Diagnose the already-failing CI baseline separately.

## Required boundaries

- No hashes, faked runtimes, additional schedulers/mailboxes/services, generic
  execution framework, arbitrary executable text in mail, or dynamic registration.
- No model/effort/tokens/inbox/reply/wait API on mechanistic identities.
- No automatic replay of possibly started work; preserve exact identity bindings,
  durable start claims, main-mail reservations, cleanup quarantine, and leases.
- A direct command's presentation choice must survive recovery; reload must not
  silently turn its automatic outcome into a new model request. Reuse the
  existing `MainAdapter` delivery capability rather than bypassing the journal.
- Zero implicit model calls does not revoke a trusted program's existing explicit
  ability to send agentic mail. A program deliberately notifying an LLM still uses
  ordinary authorized routing. The read-only CI program does not do that.
- Keep progress in the existing UI. The accepted job ID remains authoritative on
  interruption, timeout, or delivery uncertainty; never retry accepted work.
- Read supported Pi docs fully before changing command/output behavior. Test real
  interactive/headless semantics rather than substituting final prose markers.
- Real GitHub inspection is read-only and opt-in for live verification. No reruns,
  dispatches, deployments, workflow cancellations, or remote state changes.

## CI baseline evidence (separate from UX)

Run `35521788824` on main `17febc8` failed. Saved logs live in
`.test-workspaces/mechanistic-ux/ci-baseline-{package,ubuntu,macos}.log`.

- Package allowlist and Ubuntu validation reject a 220,060-byte tarball against
  the existing 220,000-byte ceiling. Ubuntu reached the package smoke stage.
- macOS exits during the coverage-test stage, before the gate/package output.
  The workflow redirected the test report to a local file and uploaded no
  artifacts, so its exact test failure is not present in the retrieved job log.
  Do not assume its root cause is the package limit or claim it repaired without
  evidence. Make failures diagnosable and investigate independently.
- `gh run view --log-failed` produced an empty log; per-job `gh api .../logs`
  retrieved the actual evidence. A private TMPDIR avoids a shared gh cache
  permission error without changing another user's files.

Establish baseline repairs in their own commit(s); do not conceal them inside UX
changes or simply loosen limits to turn a red gate green. If an added shipped
program changes package inventory, account for the measured addition separately.

## Delivery

Use the existing Astra xhigh implementation identity and Luna low E2E identity
through production `send_email`, with serial writers. Reuse existing read-only
Sol xhigh reviewers for focused final checks. Keep the original main checkout
and its global registration unchanged. Commit coherent changes in this worktree;
no merge or push is authorized by this implementation approval. Finish with
verified evidence and explicit remaining limitations.
