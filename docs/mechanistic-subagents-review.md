# Mechanistic-subagents review

## Initial review — 2026-09-18

**Verdict:** the core direction is sound, but commit `756b750` was not ready to
implement. The reviewed plan in [`mechanistic-subagents.md`](mechanistic-subagents.md)
now closes the verified contract gaps. Production implementation and E2E
validation remain outstanding.

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

## Final review

Pending implementation and reusable E2E evidence. The same five identities will
re-review the plan against the actual code, packed artifact, deterministic logs,
and opt-in live-model evidence. Verified remaining blockers will be routed back
to the original implementation or E2E owner before this section is finalized.
