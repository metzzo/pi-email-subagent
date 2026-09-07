# Review findings and remediation — 2026-09-07

Baseline: `0b0ea48` (Pi 0.85.0). The pre-existing change in `test/unit/work-ledger.test.ts` is outside this task and must remain untouched.

Review covered software design, agent coordination, LLM runtime behavior, Pi integration, and local git history. It was targeted, not exhaustive. Original reproductions and full baseline test logs are in the ignored `.test-workspaces/review-2026-09-07/` directory.

## Confirmed issues

1. **High: accepted mail lost after recovery of a missing final newline.** `MailStore.init()` accepts a complete final JSON event without LF but does not repair the delimiter. A later append joins two objects; another restart can discard both. Original probe: `probes.log` / `journalTail`.
2. **High: accepted mail reported as not accepted.** The final registry save in `AgentBroker.sendInternal()` is outside its post-journal error boundary. A real registry rename failure leaves accepted queued mail but `send_email` reports `EMAIL_NOT_ACCEPTED`, without its ID. Original probe: `probes.log` / `postJournalFailure`.
3. **Medium: turn/token budgets act only after settlement.** Worker turns and provider usage are checked after a full run, not before continuing. Real Pi RPC probes with either limit set to one completed three assistant turns and 45 input/output tokens, including a successful reply, before failure. Original evidence: `budget-probe.log` and corresponding canonical RPC/session/mail artifacts.
4. **Medium: lockstep model metadata removes configured instructions.** `budgetPromptAdditions()` treats `maxTokens >= contextWindow` as no input allowance, unlike the envelope fix in `4992ebd`. The later `a2d4f42` calculation drops administrator policy and role instructions while work remains admitted. Original probe: `probes.log` / `lockstep`.

The suspected extension tool-activation bypass did not reproduce on Pi 0.85.0 and is not a finding.

## Complete implementation plan

1. Add real-file regression tests for unterminated complete journal events, reply recovery, and delimiter-repair failure. Normalize a missing final delimiter through the existing atomic replacement path before any recovery append. Commit this fix with its tests.
2. Add real broker/store regression tests using filesystem faults after acceptance. Preserve the accepted mail ID and typed post-acceptance failure through registry/publication/failure-finalization errors; do not retry or fabricate a new request. Commit this fix with its tests.
3. Inspect the supported Pi turn/provider boundaries. Add real AgentSession/RPC regression tests proving no further model turn is admitted after the turn budget, and no further continuation after reported token exhaustion. Keep Pi retry ownership, exact-generation cleanup, per-delivery/enforcement baselines, and durable obligations. Document unavoidable in-flight token overshoot. Commit this fix with its tests.
4. Reuse one interpretation of model input allowance for envelope and prompt budgets. Preserve complete configured policy/instructions for lockstep metadata. Fail before new-work acceptance when required additions cannot fit rather than removing constraints. Add boundary, startup, and regression coverage; update affected documentation. Commit this fix with its tests.
5. Run TypeScript, focused regressions, the complete deterministic coverage suite, package/license checks, and packed-artifact smoke. Capture complete output durably on the first run; diagnose any failure rather than treating a rerun as a fix. Check the final diff and repository status, account for the pre-existing edit, and record results below.

## Completion gates

- [x] Journal delimiter recovery preserves accepted mail across further appends/restarts.
- [x] Every observed post-acceptance send failure preserves its accepted ID/status.
- [x] Real Pi execution respects turn admission and reported-token continuation limits.
- [x] Lockstep model instructions are preserved; insufficient instruction capacity rejects work.
- [x] Local validation gates pass with preserved logs and remaining gaps disclosed.

## Not covered by this task's local validation

Paid providers, real-model task-quality evaluation, manual TUI interaction, non-Linux execution, sudden-power-loss durability, and external GitHub issue history. Gitleaks was unavailable locally; secret scanning and remote clean/pushed release-evidence generation were not run. No sandboxing or exactly-once presentation guarantee is added. Token limits use reported assistant input/output usage, not provider-internal retries, cache tokens, or Pi summarization costs; admitted responses and their tools can finish before token overspend is known.

## Results

All four confirmed issues have fixes and regression coverage; five of five scoped completion gates are captured, with no outstanding implementation gate.

- Journal: `b5e8a2f`; real-file delimiter variants, atomic repair failure, and reply-recovery append/restart tests.
- Acceptance: `ebd6e3a` and `4fcd714`; real registry/journal filesystem faults and publication failure preserve accepted IDs through the mail-tool boundary. Routing-complete bookkeeping failures do not fail delivered mail.
- Budgets: `17682c4`; composed public Pi context/next-turn hooks preserve native authentication/retry/compaction ownership. RPC tests cover turn exhaustion, token overshoot, exact token exhaustion, exact-limit completion and later-delivery resets. Real AgentSession coverage checks native retry rejection without counting its synthetic error as an admitted turn.
- Instructions: `29fc88e`; shared metadata calculation, whole-value UTF-8 boundaries, real worker prompt contents, pre-acceptance rejection without a lease/record/factory, and main-startup rejection. `9fdcfeb` covers prompt rendering through Pi's actual module loader as well as direct TypeScript imports.

Evidence root: `.test-workspaces/remediation-2026-09-07/` (git-ignored).

| Validation | Exit | Complete artifact |
| --- | --- | --- |
| TypeScript (`npm run check`) | 0 | `check-complete.log` |
| Journal regressions | 0 | `mail-green.log` |
| Acceptance/tool and routing regressions | 0 | `acceptance-green.log`, `acceptance-compat.log` |
| Budget RPC and SDK/broker regressions | 0 | `budgets-green.log`, `budgets-sdk-green.log` |
| Prompt unit/broker and real startup regressions | 0 | `prompts-green.log`, `prompts-main.log` |
| Pi module-loader prompt contracts | 0 | `prompt-loader.log` |
| Complete default suite (`npm test`) | 0 | `full-suite-complete.log` |
| Complete serialized coverage suite and unchanged ratchet | 0 | `coverage-gate-green.log`, `coverage-tests-green.log`, `coverage-green.lcov` |
| Dependency licenses | 0 | `licenses.log` |
| Package policy | 0 | `package-policy.log` |
| Packed-artifact smoke | 0 | `package-smoke-complete.log` |
| Final whitespace/diff check | 0 | `diff-check.log` |

Original failing output is retained, including red regressions and test-fixture corrections. The first default full suite (`full-suite.log`) caught two old delivery-wording assertions; the diagnostic now distinguishes delivery from bookkeeping failure without weakening those assertions. The first coverage gate (`coverage-gate.log`) exposed uncovered Pi-loader prompt paths; direct TypeScript coverage alone did not cover both loaded implementations. Added host-loader contracts rather than lowering thresholds. Their first full run (`coverage-tests-2.log`) rejected an incorrect assumption that discovery loads only the explicit fixture; the test now checks the exact requested extension, allowing ordinary discovery. Final coverage and focused loader tests pass.

Repository accounting: only the pre-existing `test/unit/work-ledger.test.ts` edit remains outside these commits. It was neither edited nor staged by this task. This is local remediation evidence, not approval to publish a dirty or unpushed candidate.
