# Extension Review — pi-email-subagent

Date: 2026-07-25. Scope: full source (`src/`, 16 files, ~4,150 LOC), extension entry, config, prompts, UI, README, tests. `tsc --noEmit` clean; 79/79 tests pass at review time. Uncommitted conversation viewer/preview changes included in scope.

## Overall assessment

Well-engineered: journaled mail store with crash repair and a reply reservation protocol, per-address serialized broker with capacity leases and lifecycle generations, disciplined prompt escaping, sanitized UI rendering, 0600/0700 file permissions, and a strong test suite.

## Findings

### Bugs

1. **Long subjects can never be answered.** `broker.ts` `validateInput` enforces `maxSubjectBytes` (512) on reply subjects, but `makeReplySubject` adds a `Re: [<30-char id>] ` prefix (~34 bytes). Requests with subjects > ~478 bytes produce unanswerable replies → permanent unanswered obligation → enforcement exhausts → agent failed. Fix: allow the reply-prefix overhead when validating reply subjects.
2. **Unhandled promise rejections.** Fire-and-forget calls without `.catch`: `broker.ts` `void this.persistRegistry()` / `.finally()` in `onWorkerEvent`, `void this.schedule/resumeEnforcement/onWorkerSettled`, and `index.ts` `void refreshConversationSources(...)`. A rejection (e.g., disk error) becomes an unhandled rejection in the host Pi process. Fix: swallow/route all of them.
3. **`paused` is not terminal in `waitForReplies`.** `waitItem()` handles failed/stopped/archived but not paused; agents overflowed by `maxAgents` at restore stay paused with no worker, so waiters block until timeout every time. Fix: report `paused` as a terminal state.
4. **`SdkWorker.start` sessionStartEvent reason mismatch.** `reason: "resume"` is chosen from `record.sessionFile` even when the file is missing and `SessionManager.create` is used. Fix: derive both from the same `existsSync` condition.
5. **`looksLikeReply` false positive.** Any new subject starting with `Re:` is rejected as malformed. Fix: only reject `Re: […`-shaped subjects.

### Performance

6. **Registry rewrite on every worker event.** `onWorkerEvent` → `persistRegistry()` per tool call/message/activity — a full atomic rewrite each time. Fix: persist on state/failure transitions and settlement; skip activity-only events (still persisted at settle/stop/shutdown).
7. **Mail journal grows forever.** Append-only with full re-read and validation at every session start. Fix: snapshot compaction (one `email.created` per live envelope, atomic rename) when the journal exceeds a threshold.

### Design observations

8. **Hardcoded model policy.** `k3`/`gpt-5.6-sol`/`gpt-5.6-terra` baked into every system prompt regardless of routability. Fix: make the policy text configurable (`modelPolicy` config key), current text as default.
9. **Workers can spawn workers** — contained by rate limits and `maxAgents`. **Fixed:** `canSpawn` role/address option (default `true`); spawn-disabled agents cannot create identities but may reuse existing ones, with config validation, prompt disclosure, `inspect_agent` visibility, and broker enforcement.
10. Failed batch prompts permanently fail envelopes (documented at-least-once philosophy); intentional.
11. Activation leases retained for failed workers until `archive` (intentional capacity accounting).

### UI (uncommitted conversation feature)

12. **Interval leak — verified non-issue.** pi's `showExtensionCustom` calls `component.dispose?.()` on every close path (`interactive-mode.js`); `ConversationComponent.dispose()` clears the timer. No change needed.
13. **`ConversationSource.refresh` clears cached blocks on transient errors**, blanking the preview on a momentary stat/read failure. Fix: keep last good blocks, only set `error`.

## Fix plan (this branch)

| # | Fix | Files | Status |
|---|-----|-------|--------|
| 1 | Reply-subject byte allowance (+64B for `Re: [id] ` prefix) | `src/broker.ts`, `test/integration/hardening.test.ts` | done |
| 2 | Catch all fire-and-forget promises (`swallow` helper) | `src/broker.ts`, `src/index.ts`, `src/ui.ts` | done |
| 3 | `paused` terminal wait state | `src/types.ts`, `src/broker.ts`, `src/main-tools.ts`, `test/integration/hardening.test.ts` | done |
| 4 | Consistent resume/new reason | `src/sdk-worker.ts` | done |
| 5 | Narrow `looksLikeReply` to `Re: [` shapes | `src/reply.ts`, `test/unit/reply.test.ts` | done |
| 6 | Persist registry on state/settled events only | `src/broker.ts` | done |
| 7 | Journal snapshot compaction (>8192 events, atomic rename) | `src/mail-store.ts`, `src/broker.ts`, `test/unit/mail-store.test.ts` | done |
| 8 | Configurable `modelPolicy` (default preserved) | `src/config.ts`, `src/types.ts`, `src/prompts.ts`, `src/broker.ts`, tests | done |
| 12 | Interval leak — verified non-issue; host calls `component.dispose?.()` on every close path | — | verified |
| 13 | Keep last good blocks on refresh error | `src/ui.ts`, `test/unit/conversation-ui.test.ts` | done |

Validation after fixes: `tsc --noEmit` clean; 84/84 tests pass (5 new regression tests: reply-subject allowance, paused wait state, `looksLikeReply` narrowing, journal compaction, `modelPolicy` override; plus prompt policy test). `README.md` documents `modelPolicy` and journal compaction. Deferred: `canSpawn` role option (finding 9, new feature).
