# `wait_for_replies` Timeout and Immediate-Rejoin Plan

Date: 2026-08-23
Status: completed — smallest messaging release implemented and deterministically validated
Priority: P2 product guidance / coordination-efficiency improvement
Classification: high-frequency, by-design UX friction; **not currently a correctness defect, lost-delivery defect, or extension-load failure**

## Executive decision

Start with the smallest change that can address the observed behavior:

1. make every timed-out `wait_for_replies` result say that pending requests remain correlated and later replies will arrive automatically;
2. explicitly discourage an immediate overlapping rejoin whose only purpose is to keep the requests alive;
3. align the main coordinator prompt and documentation with that result;
4. prove the behavior with deterministic broker and real Pi RPC scenarios that make no paid or live-provider calls.

Do **not** add a background waiter, unbounded join, polling loop, continuation token, new durable state, or new orchestration tool in the initial release. Consider new waiting machinery only if the messaging release passes its contract tests but a deterministic acceptance scenario still demonstrates a product requirement that automatic late delivery cannot satisfy.

## Implementation result

Completed on 2026-08-23 as the messaging-only first release:

- `wait_for_replies` now adds one bounded paragraph only when `timedOut: true` still contains pending items. It states durable correlation, automatic late delivery (including after restoration), no keepalive need, and optional deliberate synchronous rejoin.
- Tool metadata, the main coordinator prompt, detailed documentation, and the package overview use the same observation-window guidance.
- Broker characterization covers zero-timeout and abort followed by one ordinary exact-correlated `triggerTurn: true` delivery, plus the existing in-flight claimed-commit no-duplicate race.
- A real Pi 0.81.1 RPC scenario parses canonical tool/message events and the mail journal to prove one timed-out wait, main-turn completion without rejoin, one late reply-triggered turn, and one authoritative answer transition.
- Tool schema, 120-second default, 300-second maximum, sequential execution, collector/journal semantics, and structured result shape are unchanged. No waiting machinery or runtime telemetry was added.
- The supplied historical audit was not rerun, and no post-release organic improvement rate is claimed.

## Audit evidence

The structured-history audit supplied for this issue found:

- 829 timed-out `wait_for_replies` calls across 43 sessions;
- representative timed-out tool results at `019fb407:ab55f0ab` and `01a01825:4f23672d`;
- repeated five-minute rejoins as a common coordinator choice after a finite wait returned pending work.

Those figures came from the canonical structured history rather than text matching. They are audit inputs to this plan; this planning pass did not rerun or recalculate the historical audit.

The original planning pass inspected HEAD `6e869743957f8f5b8be99dc642af2345c9ce7ee7` (2026-08-17). It confirmed:

- `src/main-tools.ts` declares `wait_for_replies` as `executionMode: "sequential"`;
- the default is 120 seconds, the accepted range is 0–300 seconds, and each call accepts 1–32 request IDs;
- `src/broker.ts` implements a finite collector and removes its `collect: true` registrations during cleanup;
- after a collector is gone, a correlated reply to main is routed normally through `MainAdapter.deliver(... triggerTurn: true)`;
- `test/integration/hardening.test.ts` already covers timeout, abort cleanup, collection-claim races, and ordinary delivery after an aborted collector;
- `test/integration/lifecycle-races.test.ts` records the current shutdown contract: shutdown with pending work returns `timedOut: true`, even though the timer itself did not expire;
- `test/e2e/real-flow.test.ts` already proves that an uncollected correlated reply appears as a custom email message and triggers a main turn;
- `docs/wait-for-replies.md` currently says that pending IDs remain valid and may be joined again, but does not say clearly that rejoining is unnecessary to preserve delivery.

## Problem statement

A finite wait that ends with `timedOut: true` currently renders only:

```text
Replies: timed out with pending work
- mail_…: pending · Subject
```

That output accurately reports the synchronous join, but it leaves an important lifecycle fact implicit: the underlying request is still durable and the reply path is still active. A coordinator can therefore interpret timeout as “I must call the tool again or lose the reply.” Repeating the maximum 300-second join is a rational model response to that ambiguous output, even though the extension does not require it.

The user-visible cost is long stretches of sequential tool occupation and unnecessary context/tool traffic. The work itself continues in the subagent either way.

## Root mechanism

There are three distinct mechanisms, and the implementation and docs must not conflate them:

1. **Request/reply durability and correlation.** The mail journal and exact `inReplyTo` relationship survive the collector. A timeout does not cancel or detach the request.
2. **Finite synchronous collection.** While `collect: true` is active, a matching reply is claimed for the tool result and does not create a separate main turn. The call must remain bounded and abortable.
3. **Ordinary late delivery.** When the collector has cleaned up, a later correlated reply follows the ordinary main delivery path with `triggerTurn: true` and starts or queues a main turn according to Pi delivery semantics.

The observed repeated rejoin is caused primarily by the semantics presented to the coordinator, not by missing delivery. Long-running delegated work does not technically require the main thread to keep a collector open.

## Correctness versus UX classification

### Confirmed by-design behavior

- A wait is finite and sequential.
- A timeout can legitimately contain pending items.
- `collect: true` suppresses separate reply turns only while a matching collector owns delivery.
- A reply arriving after collector cleanup is delivered through the ordinary main path.
- Rejoining the same still-pending ID is allowed when the caller intentionally wants a new synchronous observation window.

### UX friction to fix

- The timeout result does not explain automatic late delivery.
- The coordinator prompt says to use `wait_for_replies`, but does not distinguish a useful join from an immediate keepalive-style rejoin.
- The docs can be read as recommending repeated joins because they emphasize that pending IDs may be joined again without first explaining that this is optional.

### What would be a correctness defect

Treat any deterministic evidence of the following as a separate blocking correctness defect:

- a reply committed after collector timeout is neither included in a collector result nor delivered as a main turn;
- the same reply is both collected and injected as a separate turn;
- a reply is correlated to the wrong request;
- timeout or abort drops a collection claim before an in-flight reply journal commit reaches its safe boundary;
- timeout, abort, or shutdown leaks a listener, timer, collection counter, or address-operation barrier.

The current inspected implementation and existing tests are designed to prevent these failures. This plan does not assume they exist.

## Goals

1. Make a timed-out result self-explanatory without requiring the model to infer broker internals.
2. Reduce immediate overlapping rejoins whose only purpose is to keep pending requests alive.
3. Preserve deliberate rejoin for synchronous collection, status refresh, or grouped context control.
4. Preserve all collector safety, correlation, cancellation, abort, and tool-output bounds.
5. Establish deterministic, no-paid-provider acceptance and a canonical-event measurement method.
6. Keep the first production patch small and reversible.

## Non-goals

- Making waits unbounded.
- Changing the 120-second default or 300-second maximum in the first release.
- Making a sequential tool parallel.
- Replacing event-driven late delivery with polling.
- Redefining `fetch_emails` to return replies.
- Changing request/reply journal schemas or correlation IDs.
- Changing `collect: true` to deliver duplicate reply turns.
- Adding progress email, keepalive traffic, or synthetic replies.
- Optimizing legitimate long synchronous collection before evidence shows it is a problem.
- Claiming that every timeout is unnecessary; a caller may intentionally want a bounded synchronous join.

## Invariants

The change must preserve all of the following:

1. **Exact request correlation:** only real request IDs returned by `send_email` are accepted; duplicates remain de-duplicated; foreign/non-main request IDs still fail the whole call before waiting.
2. **Collection semantics:** while a `collect: true` collector owns a reply, that reply appears in the wait result and does not trigger a second main turn.
3. **Post-collector delivery:** once no collector owns the request, a later reply is delivered normally with `triggerTurn: true`.
4. **Commit boundary:** timeout, abort, and shutdown continue to wait for an already-claimed reply journal commit before releasing collection ownership.
5. **Bounded execution:** timeout remains 0–300 seconds, request IDs remain capped at 32, and tool output remains within Pi's byte/line guidance and the broker's smaller framing budget.
6. **Cancellation and terminal states:** `failed`, `cancelled`, `stopped`, `archived`, and capacity-`paused` remain terminal wait outcomes; `cancelled` is not presented as completed work.
7. **Abort behavior:** an abort returns the latest partial state, cleans up listeners/timers/counters, and permits a later reply to use ordinary delivery.
8. **No fabricated lifecycle claims:** result text must not say that a reply already exists, only that a future reply remains correlated and will be delivered automatically when it arrives.
9. **No paid acceptance dependency:** release gates use fake broker results and the deterministic scripted provider.
10. **Canonical evidence:** tests and metrics parse structured tool/RPC/journal events and deduplicate by stable event/tool-call identity; they never derive counts by grepping JSONL or transcripts.

## Current code grounding

### Tool surface and rendering

`src/main-tools.ts`

- owns the public schema, sequential execution mode, defaults, prompt snippets/guidelines, result heading, per-item rendering, reply-body omission behavior, and compact structured details;
- currently renders timeout accurately but without late-delivery guidance;
- is the smallest production location for the result-text fix.

`src/tool-result.ts`

- enforces generic result bounding; no change is expected.

`src/types.ts`

- defines `ReplyWaitState`, `ReplyWaitItem`, and `WaitForRepliesResult`;
- no schema change is needed for a messaging-only fix because `timedOut`, `complete`, and per-item states already distinguish the condition.

### Collector and delivery implementation

`src/broker.ts`

- `waitForReplies()` validates IDs, registers `collectingRequestIds`, subscribes to broker changes, observes timeout/abort/shutdown, waits through `collectionClaims`, and removes collector state during cleanup;
- `sendInternal()` calls `claimCollection()` for a reply to main; without a claim it invokes `mainAdapter.deliver` with `triggerTurn: true`;
- no broker change is expected in the initial implementation.

`src/index.ts`

- registers `wait_for_replies` for main and implements the main adapter used by broker delivery;
- no change is expected unless a deterministic late-delivery test uncovers a separate adapter defect.

### Coordinator instructions

`src/prompts.ts`

- `mainCoordinatorPrompt()` says to use `wait_for_replies` instead of polling files or status tools and to continue useful work after delegating;
- it should explicitly describe timeout as the end of one observation window, not the end of reply delivery.

### Existing documentation

- `docs/wait-for-replies.md` documents finite collection and current result states.
- `README.md` gives the high-level join guarantee.
- `docs/fetch-emails.md` correctly treats `fetch_emails` as an unanswered-request query, not a reply inbox; it should not be broadened for this issue.

### Existing tests to extend

- `test/integration/main-tools.test.ts`: tool result rendering, structured details, and bounds.
- `test/unit/prompts.test.ts`: main coordinator guidance.
- `test/integration/hardening.test.ts`: timeout, abort, collection-claim race, late ordinary delivery.
- `test/e2e/helpers/mock-provider-extension.ts`: deterministic main/worker behavior.
- `test/e2e/real-flow.test.ts`: canonical Pi RPC events, real broker/journal/worker pipeline, no paid model.

## Smallest defensible design

### Timed-out result copy

When `result.timedOut` is true and at least one item remains `pending`, append one bounded paragraph after the item list. The intended meaning is:

```text
Pending replies remain correlated and will be delivered automatically to the main thread when they arrive. Do not call wait_for_replies again merely to keep these requests alive; continue useful work or end the turn. Rejoin only when you specifically need another synchronous collection/status window.
```

Final wording may be shortened to remain clear in narrow contexts, but it must retain all four facts:

1. requests remain correlated;
2. late replies arrive automatically;
3. immediate keepalive-style rejoin is unnecessary;
4. intentional synchronous rejoin remains supported.

Do not print this paragraph for a complete result. An abort currently returns `complete: false, timedOut: false` when work remains, so it must not be labeled a timeout. Pending broker shutdown currently returns `timedOut: true` in `src/broker.ts` and `test/integration/lifecycle-races.test.ts`; the initial copy must remain accurate for that branch too (durable work can resume and deliver after broker/session restoration), without silently changing the structured contract. Add a distinct end-reason field only if a failing deterministic product test proves shutdown-specific wording is necessary; that would require a compatibility-reviewed `src/types.ts`/`src/broker.ts` scope revision.

Place omission/re-fetch guidance next to omitted reply bodies, as today. The new timeout paragraph must not imply that calling again is necessary to retrieve a reply body that has not yet arrived. Once an answered body was omitted because of output bounds, the existing smaller-group re-fetch guidance remains authoritative.

### Tool metadata and main prompt

Update the `wait_for_replies` description/guidelines in `src/main-tools.ts` and the main coordination paragraph in `src/prompts.ts` to say:

- the wait is a bounded observation/collection window, not a keepalive;
- after a pending timeout, continue useful work or end the turn because late replies automatically trigger delivery;
- rejoin only for a deliberate synchronous snapshot/collection need;
- never replace it with file/registry polling or progress mail.

Avoid duplicating a long policy block in several strings. One compact tool guideline and one compact main-prompt sentence are sufficient.

### Documentation

In `docs/wait-for-replies.md`:

- describe what happens after a timed-out `collect: true` call releases its registrations;
- move “pending IDs can be joined again” after the automatic-delivery guarantee;
- give examples of valid rejoin (fresh synchronous collection, smaller grouping after an omitted body) and invalid rejoin (only keeping a request alive).

In `README.md`, add at most one high-level sentence if the detailed doc alone would leave the package overview misleading.

### No initial waiting machinery

The messaging patch intentionally leaves `src/broker.ts`, `src/types.ts`, journal persistence, and tool parameters unchanged. If all deterministic acceptance criteria pass, ship that patch and measure before proposing more.

## Test-first implementation phases

### Phase 0 — Characterize the safety boundary before changing copy

Add or tighten deterministic broker tests first:

1. Send a main-originated request.
2. Call `waitForReplies([id], 0, true)` and assert structured `{ timedOut: true, complete: false, state: "pending" }`.
3. Send the correlated reply after the collector has returned.
4. Assert one ordinary main delivery with the same `inReplyTo`, `kind: "reply"`, and `triggerTurn: true`.
5. Assert the request is answered exactly once in the parsed mail-store state/journal.
6. Assert there is no lingering collection registration/claim/listener attributable to the finished waiter.

Also retain the existing race case in which a timeout occurs while the reply delivery commit is already claimed: the waiter must hold through the commit, return the answer, and produce no separate main delivery.

If characterization fails, stop the UX patch and fix the discovered correctness defect as a separately reviewed change. Do not mask delivery loss with more reassuring text.

Likely file:

- `test/integration/hardening.test.ts`

### Phase 1 — Add failing result-copy tests

Before production edits, add tests for the rendered tool result:

| Input result | Required text | Forbidden implication |
|---|---|---|
| timed out + pending | automatic later delivery; no keepalive rejoin; deliberate rejoin remains possible | request expired/lost |
| complete + answered | normal complete result and reply body | timeout guidance |
| complete + terminal failure | normal terminal recovery signal | automatic successful reply claim |
| abort partial (`timedOut: false`) | partial semantics | “timed out” |
| pending shutdown (currently `timedOut: true`) | durable pending work can resume/deliver after restoration; preserve current structured contract | claim that the timer necessarily expired or that delivery occurs before restoration |
| timed out with many/long subjects | guidance remains present or an explicit deterministic cap policy chooses a shorter version | tool result over byte/line bounds |
| answered bodies omitted | exact smaller-ID refetch guidance remains | timeout paragraph replacing omission guidance |

Assert both visible text and `details.result`; the structured result should remain unchanged and compact request/reply bodies should remain omitted.

Likely file:

- `test/integration/main-tools.test.ts`

### Phase 2 — Implement the copy and prompt change

Make the smallest production edits:

- append conditional timeout guidance in `src/main-tools.ts`;
- align its description/prompt guideline;
- add the bounded-observation sentence in `src/prompts.ts`.

Add prompt assertions before changing prompt production text. Assertions should test the required semantic phrases without pinning an entire paragraph.

Likely files:

- `src/main-tools.ts`
- `src/prompts.ts`
- `test/unit/prompts.test.ts`

No `src/broker.ts` or `src/types.ts` change is expected in this phase.

### Phase 3 — Deterministic real Pi RPC acceptance

Extend the scripted provider with one explicit timeout scenario. The worker should delay its reply long enough for a zero- or very-short bounded wait to return pending; the main script should treat the new tool result as terminal for that turn rather than issuing another wait.

Parse the canonical RPC event buffer and assert this ordering:

1. `send_email` ends successfully and yields a real `correlationId`;
2. one `wait_for_replies` tool call ends with `details.result.timedOut === true` and the exact ID in `pending`;
3. its visible result contains the automatic-delivery/no-immediate-rejoin guidance;
4. the main turn settles without a second overlapping `wait_for_replies` start for that ID;
5. the delayed worker reply later appears as a `message_start` whose custom type is `pi-email-subagent.email` and whose envelope has the exact `inReplyTo`;
6. a new main run sees and handles that reply;
7. the parsed mail journal contains one authoritative answer transition for the request.

Do not count events with grep or regular expressions over JSONL. Use `PiRpcClient.events()`, event objects, structured tool arguments/details, and parsed JSON journal entries.

Likely files:

- `test/e2e/helpers/mock-provider-extension.ts`
- `test/e2e/real-flow.test.ts`

### Phase 4 — Documentation and compatibility review

Update the detailed wait documentation and, only if needed, the README overview. Review all examples for consistency with these distinctions:

- “may rejoin” is not “must rejoin”;
- automatic late delivery applies after collector cleanup;
- collection still suppresses a separate turn while it owns delivery;
- body omission can still require a smaller-ID retrieval call after an answer exists.

Likely files:

- `docs/wait-for-replies.md`
- `README.md` (optional, one concise clarification)

### Phase 5 — Evidence gate before any phase-two product machinery

After the messaging release, run the deterministic timeout scenario repeatedly under the standard suite. Separately, when organic session history is available, calculate the product metric below from canonical events without initiating paid work.

Only open a new machinery design if both are true:

1. a deterministic acceptance scenario states a concrete requirement not met by automatic late delivery plus optional bounded rejoin; and
2. the failure persists with the new result/prompt wording.

Examples that could justify a new design are a requirement for one-turn aggregation across an unbounded duration or a demonstrated inability of Pi to wake main after a late reply. A desire to avoid seeing a timeout line, by itself, is insufficient.

## Deterministic validation matrix

### Unit/tool rendering

- pending timeout includes all required guidance;
- complete/terminal results omit timeout guidance;
- abort partial is not mislabeled;
- request order, IDs, states, subjects, errors, and reply bodies are unchanged;
- compact structured details still omit bodies;
- byte and line caps hold with multibyte and many-line inputs;
- omitted-body recovery text remains actionable.

### Broker integration

- timeout then late reply produces one ordinary main delivery;
- abort then late reply produces one ordinary main delivery;
- timeout concurrent with a claimed commit returns the committed reply and produces no duplicate turn;
- two concurrent collectors preserve reference counts and collect once;
- `collect: false` remains ordinary delivery;
- cancellation/failure/stopped/archived/paused remain terminal;
- unknown, reply, and foreign request IDs fail before collector registration;
- shutdown cleans timers/listeners/counters and preserves the currently tested pending-shutdown `timedOut: true` contract unless a separately scoped end-reason change is approved.

### Prompt

- main prompt calls the wait bounded, or otherwise clearly describes one finite observation window;
- it says late replies arrive automatically;
- it discourages immediate keepalive rejoin;
- it retains optional deliberate rejoin and the prohibition on file/status polling and progress mail.

### Real scripted-provider RPC

- exactly one initial timed-out wait in the scenario, established by parsed `tool_execution_start/end` events and tool-call IDs;
- no overlapping immediate rejoin for the same request before late reply delivery;
- exact reply correlation and automatic custom-message turn;
- one parsed journal answer transition;
- no paid provider or network dependency.

### Package/regression

After focused red/green work, capture complete first-run output to durable artifacts and run:

```bash
npm run check
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:package
```

Do not stream away the only failure evidence. On failure, inspect the saved log's runner summary and exact failing sections rather than rerunning merely to discover the test identity.

## Measuring improvement without paid/live dependence

### Primary metric: immediate overlapping rejoin rate

From the canonical session event stream:

1. select `tool_execution_end` events for `wait_for_replies` whose structured `details.result.timedOut` is true and that contain at least one pending request ID;
2. deduplicate by session and stable tool-call ID;
3. inspect subsequent structured `tool_execution_start` events before an intervening correlated reply delivery or new user prompt;
4. count an immediate overlapping rejoin only when the next wait includes at least one of the same pending IDs and no new product need is represented in the event sequence;
5. report the numerator and denominator, cohort/version window, and unclassified cases.

Establish the pre-change baseline with this same parser; do not infer it from the supplied total of 829 timeouts. Compare it with an organic post-release cohort. Reading already-produced organic sessions creates no paid-provider dependency.

### Deterministic proxy

In CI, the scripted timeout scenario must produce zero immediate overlapping rejoins and one later automatic delivery. This is a contract regression signal, not a claim about all model behavior.

### Safety metrics

For timed-out episodes in the same parsed corpus, also report:

- later replies correlated to the exact pending IDs;
- replies collected by a later deliberate wait versus delivered as ordinary turns;
- duplicate-presentations detected for one reply ID;
- unresolved requests at session cutoff, explicitly labeled cutoff rather than lost.

Do not export message bodies, subjects, or addresses for aggregate measurement. Use stable event identities only while parsing and discard them after aggregation. Do not use hashes.

## Observability and diagnostics

The initial patch adds no runtime telemetry and no durable fields. Existing native artifacts are sufficient:

- tool arguments contain the exact request IDs;
- `details.result` contains `complete`, `timedOut`, and per-item states;
- main custom-message events contain the reply envelope and `inReplyTo`;
- the journal contains authoritative creation/delivery/answer transitions.

The visible timeout paragraph is itself the operator diagnostic. It should be bounded, deterministic, and free of recipient addresses or message contents beyond what the existing per-item result already displays.

If a safety test fails, diagnostics should name the request ID, collector tool-call ID, structured state, and event ordering. Do not dump unrelated mail bodies or full session transcripts.

## Acceptance criteria

The messaging release is acceptable only when:

1. every `timedOut: true` result with pending items states automatic late delivery and says immediate keepalive rejoin is unnecessary;
2. deliberate rejoin remains supported and documented;
3. the main prompt gives the same guidance without contradicting tool docs;
4. timeout/abort/collection-claim tests preserve exact existing semantics;
5. the real scripted-provider scenario proves timeout → main settlement → late correlated reply → triggered main turn from canonical events;
6. tool result byte/line bounds and compact details remain intact;
7. no journal/type migration or new runtime waiter is introduced;
8. all deterministic validation gates pass from preserved first-run artifacts.

## Release gates

- **Correctness gate:** characterization tests must pass before reassuring copy ships.
- **Copy gate:** required facts appear only for the correct result branches.
- **Prompt consistency gate:** tool metadata, main prompt, and docs agree.
- **No-duplicate gate:** a reply is never both collected and separately delivered.
- **No-paid gate:** acceptance uses fake broker results and the scripted provider only.
- **Measurement gate:** the canonical-event metric parser/recipe is reviewed before any improvement percentage is published.
- **Escalation gate:** no new waiting machinery enters this release.

## Compatibility and migration impact

- Tool name, parameters, execution mode, defaults, maximum, and structured result shape remain unchanged.
- Existing callers that parse `details.result` are unaffected.
- Visible tool text gains one conditional paragraph; consumers that incorrectly snapshot the whole string may need fixture updates.
- No mail journal, registry, or session migration is required.
- A later reply may already produce an automatic turn today; the patch documents rather than introduces that behavior.
- No configuration changes are required.

## Risks and races

### Misleading guarantee during an in-flight claim

A timeout request may already have a reply delivery commit in flight. Existing collection-claim logic delays timeout cleanup until the commit boundary. The result must be computed after that boundary, so guidance is based on the final returned state.

### Duplicate guidance crowds out useful content

Large multi-reply results are bounded. Add one short paragraph after items; retain the existing omission strategy and test worst-case bytes/lines. Do not repeat the paragraph per pending ID.

### Model overcorrects and never rejoins

The wording must discourage only a rejoin whose sole purpose is keepalive. It must explicitly allow a fresh synchronous collection/status window and smaller-group retrieval of an already-answered omitted body.

### Automatic delivery occurs while main is busy

`triggerTurn: true` does not imply unsafe interruption at an arbitrary token boundary; Pi applies its delivery scheduling. Tests should assert eventual structured delivery/turn, not a brittle wall-clock instant.

### Another collector starts after the first timeout

If a deliberate later `collect: true` waiter owns the request when the reply arrives, the reply is collected rather than injected. The guarantee is that no keepalive is needed and the reply has an automatic broker path, not that every late reply must create a separate turn regardless of a new collector.

### Historical metric misclassification

A rejoin can be legitimate. Report the explicit event-window definition and unclassified cases; do not label every repeated ID a defect or every timeout wasted.

## Rollout

1. Land characterization and failing copy/prompt tests.
2. Land the minimal `src/main-tools.ts` and `src/prompts.ts` change.
3. Land deterministic RPC acceptance and docs in the same release branch.
4. Run the full deterministic gates with preserved first-run logs.
5. Release behind no configuration flag; this is additive guidance only and is easy to revert.
6. Observe organic canonical-event cohorts without generating paid calls.
7. Decide whether the immediate-overlapping-rejoin rate fell and whether any safety metric regressed.
8. Open a separate design only if the escalation gate is met.

## Rejected overengineering

### Unbounded `wait_for_replies`

Rejected because it can occupy a sequential tool indefinitely, complicate cancellation/shutdown, and hide stalled or failed recipients.

### Automatic recursive rejoin inside the tool

Rejected because it recreates the observed loop invisibly, defeats the documented maximum, and removes the model/operator's opportunity to continue useful work.

### Background polling or timers

Rejected because mail delivery is already event-driven. Polling adds latency, wakeups, duplicate races, and cleanup obligations without improving correlation.

### New subscription/watch orchestration subsystem

Rejected for the initial release. The broker already maintains a durable request and automatically delivers a late reply. A second subscription lifecycle would duplicate state and require recovery semantics.

### New `pending` mailbox or unread-reply state

Rejected because `fetch_emails` represents unanswered response obligations, while replies are terminal answers. A new unread cursor would add persistence and migration work for a messaging problem.

### Raising the 300-second maximum

Rejected because the audit already shows repeated use of five-minute waits. A larger maximum delays the symptom rather than explaining that a keepalive is unnecessary.

### Changing `collect` to false by default

Rejected because it would break the useful single-turn aggregation contract and could create duplicate or extra turns for normal joins.

### Progress email or synthetic completion

Rejected because it adds coordination traffic and can misrepresent unfinished work. The existing substantive reply path is authoritative.

### Runtime telemetry with subjects, bodies, or addresses

Rejected for privacy and necessity. Existing structured events support aggregate measurement without adding sensitive durable fields.

## Expected implementation file set

Initial production/doc patch:

- `src/main-tools.ts`
- `src/prompts.ts`
- `docs/wait-for-replies.md`
- `README.md` only if one high-level clarification is needed

Expected tests:

- `test/integration/main-tools.test.ts`
- `test/unit/prompts.test.ts`
- `test/integration/hardening.test.ts`
- `test/e2e/helpers/mock-provider-extension.ts`
- `test/e2e/real-flow.test.ts`

Files specifically not expected in the initial implementation:

- `src/broker.ts`
- `src/types.ts`
- `src/mail-store.ts`
- `src/index.ts`

A change to any of those four requires a failing deterministic correctness or acceptance scenario and a revised, separately reviewed scope.
