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

- [ ] Journal delimiter recovery preserves accepted mail across further appends/restarts.
- [ ] Every observed post-acceptance send failure preserves its accepted ID/status.
- [ ] Real Pi execution respects turn admission and reported-token continuation limits.
- [ ] Lockstep model instructions are preserved; insufficient instruction capacity rejects work.
- [ ] Full validation passes with preserved logs and remaining gaps disclosed.

## Not covered by this task's local validation

Paid providers, real-model task-quality evaluation, manual TUI interaction, non-Linux execution, sudden-power-loss durability, and external GitHub issue history. No sandboxing or exactly-once presentation guarantee is added.

## Results

Pending implementation.
