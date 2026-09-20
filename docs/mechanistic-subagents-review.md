# Mechanistic-subagents review

## Initial review — 2026-09-18

**Verdict:** the core direction is sound, but commit `756b750` was not ready to
implement. The reviewed plan in [`mechanistic-subagents.md`](mechanistic-subagents.md)
closed the verified contract gaps. Implementation and E2E validation were still
outstanding at that initial review.

### Review fleet

All five reviewers were read-only GPT-5.6 Sol agents using `xhigh` effort. They
inspected the committed plan and current source rather than reviewing prose
alone.

| Focus | Identity | Correlated request |
| --- | --- | --- |
| Simplicity | `reviewer.mechanistic-simplicity@gpt-5.6-sol.com` | `mail_00mu6q2p7w_000_2026441b13` |
| Software design | `reviewer.mechanistic-design@gpt-5.6-sol.com` | `mail_00mu6q2p7y_000_ea44b24320` |
| Agentic semantics | `reviewer.mechanistic-agentic@gpt-5.6-sol.com` | `mail_00mu6q2p7z_000_0f9fc7205d` |
| Correctness | `reviewer.mechanistic-correctness@gpt-5.6-sol.com` | `mail_00mu6q2p7z_001_868c8ae978` |
| Production reality | `reviewer.mechanistic-reality@gpt-5.6-sol.com` | `mail_00mu6q2p7z_002_6728f46dea` |

The production broker confirmed `openai-codex/gpt-5.6-sol`, persisted `xhigh`
effort, reviewer role, and read-only tools for each identity.

### Accepted findings and decisions

1. **Fix the route and trust boundary before coding.** `src/address.ts:133-158`
   currently sends every domain through the model catalog, while
   `src/config.ts:464-475` loads project config only when trusted. V1 therefore
   reserves `mechanistic.com`, rejects model/persisted collisions, and accepts
   registrations only from global or trusted-project config. Dynamic/email
   registration is out of scope.
2. **Separate broker admission from program validation.** The durable acceptance
   point is the mail append (`src/broker.ts:1589-1596` at the reviewed commit).
   Unknown programs, forbidden reply/response fields, authorization, and bounds
   fail before it. JSON and program arguments are validated after acceptance and
   become a job outcome with the original mail ID.
3. **Use two concrete identity/runtime variants.** Current `ParsedAddress`,
   `AgentRecord`, `AgentInspection`, and `WorkerTransport` are model-specific
   (`src/types.ts:55-60,214-242,327-355,427-456`). A discriminated mechanistic
   record and narrow Python controller avoid fake models, effort, usage, inbox,
   or a plugin framework. Existing v1 records migrate only to the LLM variant.
4. **Keep one durable authority.** Current durable mail has email events only
   (`src/mail-store.ts:10-17`) and compaction snapshots envelopes
   (`src/mail-store.ts:653-684`). The revised design extends that journal with
   jobs keyed by the accepted mail ID, commits the start claim before spawn,
   marks possibly started work interrupted after owner loss, and never replays
   it automatically. It does not add a store or scheduler.
5. **Bypass LLM-only batching and steering for scripts.** Current high mail can
   steer a streaming worker and queued mail can batch (`src/broker.ts:2497-2518,
   2549-2562` at the reviewed commit). Mechanistic priority affects queue order
   only, and one envelope starts one serial process after the existing run slot
   is held.
6. **Define the agentic matrix explicitly.** Current worker-originated new mail
   to another worker is rejected (`src/broker.ts:1435-1439,1574-1576` at the
   reviewed commit). The revised plan adds only notification paths involving an
   authorized mechanistic endpoint or sender. LLM-to-LLM policy remains
   unchanged. Registration defaults to main-only invocation and may opt into
   authenticated LLM or mechanistic callers.
7. **Make protocol, outcomes, and cleanup finite and honest.** A versioned,
   bounded JSONL protocol, exactly one terminal report, real process-close
   precedence, bounded logs/progress/artifacts, and finite direct-child
   termination are now specified. Reported outcome, runtime outcome, and cleanup
   proof remain separate. Detached descendants and remote effects are not
   claimed stopped; this follows the existing warning in `src/types.ts:414-425`.
8. **Prove the packed artifact.** `package.json:30-37` includes all `src` and
   `docs`, while `scripts/package-policy.ts:18,34-38` capped the artifact at 51
   entries. A real pre-implementation `npm run test:package` failed at 52 entries
   after the original plan was added. The complete log is
   `.test-workspaces/mechanistic-subagents/pre-review-package.log`. The helper
   and examples must be packed under `src`, resolved from `import.meta.url`, and
   exercised from an isolated installed tarball; measured limits must be updated
   rather than bypassed.

### Rejected or narrowed suggestions

- **Do not defer both examples.** One reviewer suggested test fixtures alone,
  but the agreed deliverable includes general examples. V1 keeps two small
  examples; the command example exposes only hard-coded operations and never
  accepts executable text.
- **Do not add a generic plugin/RPC framework, new mailbox, scheduler, daemon,
  runtime registration tool, OS sandbox, or process manager.** Current evidence
  does not justify them.
- **Do not add digest-based binding.** Persist the exact resolved registration
  tuple and accepted mail ID directly; project policy forbids unrequested hash
  use.
- **Do not promise exactly-once Pi presentation or descendant cleanup.** The
  broker can preserve one logical outcome envelope and stable ID, but the host
  lacks a durable main-message append receipt and direct-child cleanup does not
  prove detached or remote effects stopped.
- **Use caller-kind authorization, not a new identity-policy language.** A small
  `main`/`llm`/`mechanistic` allowlist with a main-only default covers the
  verified permission boundary without an unnecessary rules engine.

### Validation performed before implementation

- Read `/home/claudy/Development/AGENTS.md`, the full plan at `756b750`, and the
  current address, config, type, broker, mail-store, registry, UI, prompt,
  package, and test seams cited by the reviewers.
- Confirmed branch `feat/mechanistic-subagents` and original plan commit
  `756b750bdaea82898ef9ef4f43360a77d028766d`.
- Ran `npm run test:package`; it failed only at the verified pre-existing package
  inventory cap (`52 > 51`). Full output is retained at the path above.
- No feature runtime existed, so no Python, broker integration, or live-model
  behavior was claimed tested.

## Final review — 2026-09-19

**Verdict before repairs:** all five reviewers returned `REQUEST_CHANGES`. The
implementation direction and reuse of the existing broker/store/scheduler were
approved, but the reviewers found release blockers in lifecycle control,
recovery, documentation, and the live proof. No reviewer requested another
service, scheduler, daemon, mailbox, or plugin framework.

The same read-only GPT-5.6 Sol identities and xhigh effort were used:

| Focus | Correlated final-review request |
| --- | --- |
| Simplicity | `mail_00mu8h34y9_000_df4c2a9778` |
| Software design | `mail_00mu8h34yc_000_153458de27` |
| Agentic semantics | `mail_00mu8h34yf_000_0f2c76b764` |
| Correctness | `mail_00mu8h34yi_000_58f63bd23d` |
| Production reality | `mail_00mu8h34yl_000_e6261baba5` |

The design and reality reviewers exhausted their first run budgets without a
reply. Their exact identities were inspected and restarted; they then completed
the original durable requests. Agentic and reality follow-ups independently
confirmed the physical-close defect in the reusable runner.

### Verified findings and repairs

1. **Queued work could not be abandoned.** A stopped, never-started job retained
   its identity lease and reserved main-mail capacity, while `cancel_request`
   rejected its notification trigger. Commit `a15bf18` now lets main abandon an
   exact inactive `queued` job through the existing audited cancellation
   surface. One atomic terminal transition cancels the trigger, records the
   bounded actor/reason, creates the usual stable non-correlated `abandoned`
   outcome, and starts no process. Claim races, restore/compaction, removed
   bindings, queue capacity, outcome delivery, and archive are covered. Repair
   verification then found that a clean abandonment could overwrite an older
   job's identity-wide cleanup quarantine; `4713544` preserves the existing
   state, failure, cleanup audit, and identity lease for the exact identity.
2. **Three recovery/settlement edges were incomplete.** The same commit treats a
   queued append as durable reactivation intent when the registry still says an
   identity was archived; preserves an exact possibly-accepted mail ID when
   append rollback also fails; and bounds normal stop while retaining the claim,
   run slot, and namespace if a committed spawn/progress/finalization callback
   stalls. Claimed jobs are still never replayed. Repair verification also
   found that a timed-out stopped record could appear archive-eligible while
   exact process/run authority remained. Commit `a9d1fdd` makes that authority a
   canonical archive blocker, retaining the identity lease until settlement
   without retaining a run slot after durable cleanup-unknown quarantine or
   blocking unrelated identities.
3. **Generated outcomes and inspection could exceed useful bounds.** Commit
   `78e1918` applies ordinary body/context limits to the derived notification,
   reserves one main-queue slot per nonterminal job, retains the complete report
   in the durable job, and orders bounded newest-first inspection summaries.
4. **Interpreter canonicalization broke virtual environments.** Commit
   `d48ad41` preserves the selected absolute invocation path without
   dereferencing the final venv symlink. Real `--without-pip` venv imports cover
   absolute, relative, PATH-selected, broker, and restored paths.
5. **The first strict live harness could close during a later main turn and
   treated RPC failure as physical child exit.** The Luna repair series ending
   at `3f4d68b` reduces mail delivery transitions, requires delivered outcome and
   final mail plus stable balanced main quiescence, and separates protocol
   failure from the real child `close` event. A real TERM-resistant malformed-RPC
   process test proves KILL escalation and PID removal.
6. **Current support and status prose was stale.** Commit `3425924` aligns the
   runtime, all Pi development pins, CI, and current support statements on Pi
   0.85.1 and adds a release-truth invariant. The present documentation update
   records the implemented feature, exact validation, and limits while keeping
   clearly historical Pi 0.84.2 characterizations.

### Repair verification

The same five reviewers received narrow final-fix confirmations. Simplicity
(`mail_00mu8ll3zm_000_e64ca9b420`), design
(`mail_00mu8ll3zq_000_1d04e9d07d`), agentic semantics
(`mail_00mu8ll3zv_000_8ceff3d430`), and correctness
(`mail_00mu8ll402_000_52fe1f0222`) returned `APPROVE` after inspecting
`4713544` and `a9d1fdd`. Production reality
(`mail_00mu8ll406_000_6277e93c0a`) confirmed both lifecycle fixes and the
current deterministic evidence, then returned `REQUEST_CHANGES` only because
this document called the older `a15bf18` evidence index complete. The evidence
list below now labels that index as earlier and names the final-code logs; no
post-edit approval is claimed.

### Pre-merge final evidence

These local artifacts remain under `.test-workspaces/mechanistic-subagents/`
in `/home/claudy/Development/pi-email-subagent-worktrees/mechanistic-subagents`.

- Production-focused repair suite: 169/169 passed after the final
  quarantine/archival cases.
- `npm run test:e2e`: 73/73 passed across 5 suites on the final lifecycle code
  (`final-current-e2e.log`).
- `npm run validate`: 591/591 passed across 38 suites; all 33 source coverage
  thresholds, TypeScript, and production-license checks passed.
- Packed smoke: 60 files on Pi 0.85.1 and a successful installed Python job.
- Final-code opt-in `openai-codex/gpt-5.6-luna` run at `a9d1fdd`: outer command,
  runner, and Pi child all exited 0. The artifact
  `.test-workspaces/mechanistic-subagents/live-mechanistic-1789849041732.json`
  contains exactly four notification-only envelopes, delivered outcome/final,
  linked IDs/nonce, successful terminal evidence, confirmed cleanup, 3/3/3 main
  starts/ends/settlements, protocol status `ok`, and observed physical close;
  command output is in `live-mechanistic-final-code.log`.
- The earlier `a15bf18` repair set is indexed by
  `.test-workspaces/mechanistic-subagents/final-repair-summary.json`. Final
  pre-merge deterministic evidence is in `quarantine-erasure-*`,
  `archive-stall-*`, and `final-current-e2e.log`.

### Merge and global installation verification

`main` was fast-forwarded to `db5d632` and installed globally from the main
checkout. The old direct-file registration was removed; other settings stayed
unchanged. Validation and both live workflows passed using global discovery:
a local wrapper removed the runners' explicit extension flags before executing
the real Pi CLI. See [current validation status](mechanistic-subagents.md#validation-status)
for the new evidence; the earlier review verdicts remain unchanged.

### Remaining limits

Trusted Python is not sandboxed. Cleanup proves only the direct child and its
observed pipes, not detached descendants or remote effects. The journal does not
claim sudden-power-loss/fsync durability. Pi main-message presentation remains
at least once because the host exposes no durable append receipt. Live evidence
covers the requested Luna model and Pi 0.85.1 only.
