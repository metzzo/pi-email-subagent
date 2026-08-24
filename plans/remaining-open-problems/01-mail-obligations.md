# Cluster 1 — Durable Mail and Obligation Semantics

Status: implemented; nested delegation remains deliberately disabled pending an upstream durable presentation receipt
Implementation commits: historical cluster commits through `16f54eb`, remediation `018f25b` and `1465343`
Priority: P1
Depends on: existing `MailStore` reservation/answer atomicity and exact settlement ownership
Blocks: release, truthful failed-recipient recovery, safe nested delegation

## Cluster objective

Make every accepted request, reply, failure, wait, and automatic action preserve one exact obligation. No completion text may close unrelated work, no ordinary send may recover a failed runtime, and no collected reply may be called durably presented without a Pi acknowledgement.

## Current protocol surface

The current durable mail journal already separates:

- `email.created` acceptance;
- request delivery;
- `email.reply_reserved` reservation of one exact answer;
- reply delivery;
- request answer;
- failed delivery;
- administrative cancellation.

The remaining defects are mainly broker decisions above that journal:

- `AgentBroker.sendCompletionReplies()` maps one final assistant text over every current unanswered request;
- `AgentBroker.ensureWorker()` special-cases `stopped` but not `failed`;
- `resolveAgentProfile()` defaults `canSpawn` to `true`;
- `collectingRequestIds` and `collectionClaims` are in-memory presentation controls, not durable presentation receipts;
- `AgentInspection.pendingReplies` recomputes a different predicate from `classifyArchiveBlockers()`.

## Issue inventory

| ID | Problem | Broken invariant | Owner | Gate |
|---|---|---|---|---|
| MAIL-1 | One completion text can answer multiple requests | one result → one substantive obligation | extension | P1 |
| MAIL-2 | Mail to `failed` can create a worker | recovery requires explicit effect review | extension | P1 |
| MAIL-3 | Default nested spawning lacks a durable parent dependency contract | parent cannot finish before child dependency | extension | P1 default surface |
| MAIL-4 | Collection can answer before tool-result presentation is durable | answer and presentation have different crash boundaries | Pi core + extension policy | P1 guarantee |
| MAIL-5 | Pending-reply and recovery wording drift | one canonical protocol truth | extension | P3, same branch |

---

## MAIL-1 — Completion attribution

### Evidence in the current mechanism

`AgentBroker.onWorkerSettled()` calls:

```text
outstanding = fetchUnanswered(address)
sendCompletionReplies(address, outstanding, completionText, settlement)
```

`fetchUnanswered(address)` returns every delivered unanswered inbound request for the identity, not only requests causally handled by the settling run. `sendCompletionReplies()` then:

- forwards the same final text to every request when all senders match; or
- sends a generic terminal notice to every request when senders differ.

The settlement lease protects worker/generation ownership. It does not establish semantic attribution between final text and each mail ID.

### Concrete failure timelines

#### Same sender, unrelated requests

1. Request A is delivered and remains open.
2. Request B arrives later from the same sender.
3. The worker produces final text that addresses only B and does not call `send_email`.
4. Settlement sees A and B as outstanding.
5. The same B result is committed as the answer to both A and B.
6. A can no longer be recovered through the normal unanswered-mail path.

#### Different senders

1. Requests A and B come from different senders.
2. The worker finishes without dedicated replies.
3. The broker sends a generic “finished a batch” notice for both.
4. Both requests become answered even though neither received a result or blocker specific to its request.

#### Nested dependency

1. Parent worker receives request P.
2. Parent sends child request C and then emits interim final text.
3. P remains incoming to the parent; C is outgoing from the parent.
4. Mechanical fallback can answer P without waiting for C.
5. The later child reply has no remaining parent obligation to resume.

### Recommended release behavior

Use the smallest safe rule:

1. **Never loop one completion text over several requests.**
2. **Never use a generic notice as a terminal answer.**
3. Mechanical fallback, if retained, is allowed only for one exact request attributable to the current accepted run and only when the worker has no open outgoing request.
4. If attribution is unavailable, leave the obligation open and use mailbox enforcement.
5. Exhausted enforcement marks the worker failed but never answers the request.

### Design decision before implementation

Choose one of these with a red test first:

- **Preferred simple option:** remove mechanical completion entirely. Assistant text remains visible only in the worker session; only a valid `send_email` reply closes an obligation.
- **Compatibility option:** retain a single-request fallback. The broker must carry the exact accepted request IDs for the current run generation and prove there is exactly one eligible request and no child dependency.

Do not add semantic text classification. The broker must not ask an LLM, regex, or heuristic whether final text “looks like” an answer.

### If the single-request fallback is retained

The in-memory run lease needs only:

- worker object and generation;
- batch/run generation;
- exact request IDs admitted by the prompt that started the run;
- whether the run is mailbox enforcement rather than a new batch.

It must not persist prompt bodies or completion text. A crash loses the fallback opportunity and leaves the durable request open, which is safe.

High-priority steers are not automatically attributable to the original batch. Unless an exact request ID is added to the same run lease at accepted steer time, they disqualify mechanical fallback.

### Red tests

- two requests from the same sender, final text addresses only the second;
- two requests from different senders;
- one inbound request plus one open outgoing child request;
- high-priority request steered into an existing run;
- a new request races settlement after the run snapshot;
- settlement from a stale worker/generation;
- mailbox enforcement exhaustion leaves every request unanswered;
- if retained, one exact single request receives one fallback reply and one answer event.

### Done when

- no branch sends one body for multiple mail IDs;
- no generic notification commits `answeredAt`;
- tests parse the journal and observe exact request/reply/answer IDs;
- stale settlement cannot answer mail admitted to a replacement generation.

---

## MAIL-2 — Failed-recipient admission and explicit recovery

### Evidence in the current mechanism

`AgentBroker.ensureWorker()` currently checks `existingWorker` before it checks the record state, and it returns without creating a worker only when `record.state === "stopped"`. Therefore:

- a `failed` record with a still-attached worker can receive routed mail; and
- a `failed` record with no worker proceeds to `createWorker()`, which sets the record to `spawning` and deletes `record.failure`.

This means an ordinary request or a late child reply can route into or restart a failed identity without `manage_agent restart`.

### Concrete failure timeline

1. A writable worker completes or may have completed an effect.
2. The provider terminates and the record becomes `failed`.
3. Main receives the failure alert and has not yet reviewed Work/Conversation.
4. Ordinary new mail or a child reply arrives.
5. `ensureWorker()` creates the same worker automatically.
6. The model resumes with open mail and may repeat the effect before explicit review.

### Target state transition

```text
failed + accepted ordinary mail
  -> journal email.created
  -> keep envelope queued
  -> keep identity failed
  -> return recipientDisposition="failed"
  -> no workerFactory call

failed + explicit manage_agent restart
  -> verify no cleanup quarantine
  -> create the same identity/session binding
  -> deliver queued mail once
```

### Required admission and API changes

Known failed identity admission must not require current catalog/provider readiness. `sendInternal()` currently calls `resolveExistingRecord()` before and inside the recipient address operation, so a failed identity whose persisted model was removed can be rejected before `email.created`.

Introduce an explicit recipient-route decision:

- `{ kind: "failed-known", record }` uses the canonical persisted address/provider/model only for identity and diagnostics; it does not call `resolveExistingRecord()`;
- `{ kind: "routable", parsed }` retains normal catalog/binding resolution;
- unknown addresses still require full pre-acceptance routing/provider checks.

Then:

- add `"failed"` to `RecipientDisposition`;
- check failed state before both existing-worker routing and new worker creation;
- return the failed disposition without `routeToWorker()` or `createWorker()`;
- reject effort/lifecycle overrides normally because the identity already exists;
- validate exact reply ownership/subject normally;
- preserve the durable queued envelope and stable correlation ID;
- defer model/provider/auth readiness for this identity to explicit `restart()`.
- Keep `waitForReplies()` terminal state as `failed` while the identity remains failed.
- Make the `send_email` tool result say that mail was accepted and queued but the recipient remains failed and requires explicit restart.

The send must not throw “not accepted” after `email.created`. Conversely, a deterministic pre-acceptance provider/auth rejection for a brand-new identity must not create the envelope. Cluster 2 defines those preflights.

### Red tests

- failed worker with recorded write, then ordinary request;
- failed worker with no recorded work, then ordinary request;
- failed parent receives a reply to an outgoing request;
- ordinary request to a failed identity after its persisted model is removed from the catalog;
- child reply to a failed parent after its persisted model is removed;
- several queued envelopes while failed;
- explicit restart delivers each queued ID once;
- restart blocked by cleanup quarantine leaves mail queued;
- send result reports `accepted`, `queued`, `failed`, and `spawned: false` without contradiction.

### Done when

- only `restart()` can create a worker from `failed`;
- mail remains durable and visible while recovery is pending;
- no recovery path creates a new identity, provider binding, or envelope ID.

---

## MAIL-3 — Nested delegation and parent dependencies

### Evidence in the current mechanism

- `resolveAgentProfile()` defaults `canSpawn` to `true` for unknown roles.
- A subagent can send a response-required request to a child.
- Only main has `wait_for_replies`; a parent relies on later ordinary mail.
- `onWorkerSettled()` considers the parent's incoming unanswered mail, not its outgoing unanswered child request, when deciding mechanical completion.
- Terminal child failure alerts main but does not guarantee a durable correlated blocker reply to the parent.

### Safe default and permission meaning

Change the unknown/default profile to `canSpawn: false`, and define the existing setting as **subagent delegation permission**, not merely unknown-identity creation.

For a subagent sender with `canSpawn: false`:

- reject every new response-required request to another subagent, whether the recipient is known or unknown;
- allow exact replies to requests that belong to the sender/recipient pair;
- allow mail to main under the ordinary mail rules;
- do not treat reuse of an existing identity as permission to delegate.

This is the smallest compatible schema: retain the `canSpawn` config key for existing users, but label it “can delegate” in prompts/UI/docs. A future rename is unnecessary unless a distinct creation-only permission is actually required.

Keep explicit role/address opt-in. Update:

- `resolveAgentProfile()`;
- the sender-side gate in `sendInternal()`;
- legacy/default expectations in config and registry tests;
- `makeUnavailableRecord()` and prospective inspection;
- prompts and configuration docs.

Built-in roles should be explicit rather than inheriting the default. If a built-in role is allowed to delegate, its config should say so. Until the atomic parking/blocker contract below passes, force `canSpawn: true` to disabled with a bounded configuration warning rather than exposing an unsafe opt-in.

### Opt-in parent/child contract

For explicitly enabled spawning:

1. Child request C remains an outgoing unanswered blocker on the parent.
2. Use conservative identity-scoped joining: while any outgoing child request is open, park all upstream obligations for that parent identity.
3. Parking releases the parent's run slot, does not consume mailbox-enforcement attempts, and does not spin reminder prompts.
4. A child reply to C is prioritized from the parent queue, wakes the persistent parent through ordinary scheduling, and ends the park only after the outgoing blocker closes.
5. Parent request P is not mechanically completed while C is open.
6. Reject an explicit reply from the parent that would close an upstream request while the outgoing dependency is open; otherwise the worker could bypass fallback protection.
7. Terminal child failure creates a durable, correlated blocker result for C or leaves C visibly open with a deterministic parent wake-up. It must not exist only as a main UI alert.
8. The parent decides how to answer P after inspecting the child result/failure.
9. Only the parent's exact reply after dependency settlement closes P.

### Atomic dependency transition

Worker `send_email` currently permits parallel execution, and broker address operations are keyed by recipient. A child request and an upstream reply from the same parent can therefore target different recipients and race.

Add one short atomic mail-admission transition around dependency validation plus the journal mutation. The simplest correct implementation is a broker/MailStore-wide transition mutex; mail rates are already bounded, and this avoids deadlocks across sender, original sender, and recipient address locks.

Inside that transition:

1. re-read canonical outgoing blockers for the subagent sender;
2. for a new child request, validate delegation permission and append `email.created`; that durable request is the dependency state;
3. for an upstream reply, reject while an outgoing dependency or its reserved blocker reply is open **before** `reserveReply()` or any journal append;
4. for a child reply/blocker, reserve the exact outgoing request atomically; keep the dependency open until delivery commits the answer;
5. wake the parent only after that exact answer transition.

Keep provider startup/routing outside the short journal transition. The worker tool can remain parallel; atomic admission supplies the correctness boundary. A process crash before the child `email.created` leaves no dependency, while a crash after it restores the dependency from the journal. No separate dependency ledger is needed.

Add a parallel two-`send_email` test where the same parent concurrently attempts child delegation and upstream reply. Exactly one valid ordering may commit; no rejected upstream reply may leave `replyReservedBy` stranded.

### Required failure delivery

Commit to a correlated, idempotent system-generated blocker reply when the failed child's request came from a non-main delegating parent and no reply is reserved. Main-origin requests remain open for explicit same-identity inspection/restart. If this blocker cannot be made crash-safe, keep opt-in delegation disabled rather than leaving the parent parked indefinitely. The parent blocker must contain:

- child request ID;
- failed identity/provider/model summary;
- whether current work evidence indicates possible effects;
- explicit same-identity recovery guidance;
- no raw provider error or private work contents.

This is a terminal status result for C, not a claim that C succeeded. It must use the existing mail reservation/answer protocol rather than a new dependency journal. Its creation must be idempotent by exact child request ID and recoverable by scanning open non-main child requests after a crash.

### Red tests

- default unknown role cannot delegate to an unknown recipient;
- default-disabled parent cannot delegate to a known existing recipient;
- default-disabled parent can still send an exact reply and mail main;
- explicit role opt-in can delegate;
- parent settles while child request is pending;
- child replies after parent becomes parked/idle and its run slot was released;
- mailbox enforcement does not spin while the dependency is open;
- explicit premature upstream reply is rejected;
- child terminal failure before any tool;
- child terminal failure after mutation/shell/custom work;
- crash before and after idempotent child-blocker journal commit;
- parallel child request versus upstream reply under different recipient addresses;
- rejected upstream reply leaves no reservation;
- parent failure while child reply is queued;
- restart of parent delivers child result once;
- no child result automatically answers the parent's upstream request.

### Done when

- nested spawning is disabled by default;
- opt-in nested work cannot use mechanical parent completion while a child dependency is open;
- a child result or blocker remains durable across parent inactivity and restart.

---

## MAIL-4 — Collected-reply presentation crash boundary

### Evidence in the current mechanism

For a reply to main during `waitForReplies(..., collect: true)`:

1. `sendInternal()` reserves the exact reply.
2. `claimCollection()` sees the in-memory collector.
3. Main custom-message delivery is suppressed.
4. `mailStore.markDelivered()` commits reply delivery and request answer.
5. `waitForReplies()` resolves with the reply in its tool result.

The journal commit in step 4 can happen before Pi durably appends/presents the tool result from step 5. A crash in that interval restores an answered request with no ordinary main delivery path.

The Pi 0.81.1 extension/SDK documentation exposes `pi.sendMessage()` and `pi.appendEntry()`, but no public acknowledgement that a custom tool result has been durably appended and presented. This makes an exactly-once collected-presentation claim unsupported at the extension layer.

### Required decision probe

Before changing durable mail schema, add a deterministic Pi characterization test that kills the process at each boundary:

- reply reservation committed;
- collection claim acquired;
- reply delivery/answer committed;
- wait tool execute promise resolved;
- tool result entry observed in the main session file.

Parse both mail journal and main session branch by stable IDs. Do not infer presentation from stdout text alone.

### If Pi exposes a supported staged-result receipt

A simple acknowledgement before `wait_for_replies.execute()` returns is circular: Pi cannot append the tool result until `execute()` supplies it. The required Pi-core contract is a staged result with a post-append callback/receipt:

```text
reply created/reserved
  -> collection claimed
  -> wait tool returns stable-ID staged reply payload without answering
  -> Pi durably appends the exact tool result entry
  -> Pi acknowledges toolCallId/result entry ID to the extension
  -> extension commits reply delivery/request answer
  -> Pi continues the agent only after that commit callback settles
```

Restoration reconciles exact mail request/reply IDs with the staged tool-call/result entry ID:

- reserved with no appended staged result: keep open and resume ordinary/staged presentation;
- staged result appended but answer not committed: finish the journal commit without a second visible delivery;
- answered and staged result appended: terminal;
- collector gone before staging: ordinary main delivery resumes.

Any new durable marker must be keyed by exact request, reply, tool-call, and result-entry IDs and have migration, maintenance, and compaction tests. Do not implement a partial ordering that lets the next model step run before the answer commit.

### If Pi exposes no receipt

Do not invent one.

- Document that collection is at-most-one live presentation, not crash-proof exactly-once presentation.
- Consider making `collect: false` the conservative default only after testing the duplicate-turn/UX impact.
- Keep the journal answer authoritative and expose Conversation/mail inspection for crash recovery.
- File the Pi-core requirement: a supported session/tool-result append acknowledgement visible to the extension before tool execution is considered presented.

### Red tests

- timeout while reply commit owns a collection claim;
- abort while reply commit owns a claim;
- crash after answer commit but before tool result entry;
- crash after tool result entry but before ordinary collector cleanup;
- late reply after collector timeout goes through ordinary main delivery;
- no duplicate collect result plus custom message;
- stable IDs survive restore.

### Done when

Either:

- the supported Pi receipt proves one eventual presentation across the characterized crash windows; or
- documentation and tool descriptions explicitly narrow the guarantee and no test or UI claims more.

---

## MAIL-5 — Canonical blocker counts and wording

### Current drift

`classifyArchiveBlockers()` treats a reserved answer as pending when the original request is either incoming to or outgoing from the identity. `inspectAgent()` separately calculates `pendingReplies` with `email.to === address`, which misses reserved replies to requests sent by the identity.

Some recovery wording also blurs:

- accepted versus delivered;
- stopped versus failed;
- provider retry versus terminal recovery;
- “wait” versus explicit recovery when process cleanup is unknown.

### Target

- Set `AgentInspection.pendingReplies = archiveBlockers.pendingReplies.count`.
- Keep one classifier as the source for archive eligibility, UI, and inspect results.
- Cover inbound and outbound reservations.
- Make post-accept send results use exact terms: accepted, queued/delivered, failed/stopped, explicit restart required.
- Do not tell an operator to wait for cleanup that Pi 0.81.1 cannot automatically verify.

### Red tests

- inbound reserved reply;
- outbound reserved child reply;
- same envelope visible through inspect, dashboard, and archive blocker count;
- post-accept failed recipient result;
- cleanup-quarantine guidance does not promise eventual automatic release.

## Cluster work packages

1. **MAIL-1:** choose/remove or restrict completion fallback; land exact journal tests.
2. **MAIL-2:** add failed disposition and explicit-restart admission behavior.
3. **MAIL-3a:** disable default nested spawning and update config migration/docs.
4. **MAIL-3b:** implement atomic opt-in dependency admission/parking/idempotent blocker delivery; otherwise keep delegation disabled.
5. **MAIL-4:** run Pi presentation characterization; implement receipt path or narrow guarantee.
6. **MAIL-5:** unify counts and wording.

Do not combine MAIL-4 schema work with MAIL-1/2. The unsupported Pi boundary must not delay the extension-fixable protocol corrections.

## Cluster validation

Focused files:

- `test/unit/mail-store.test.ts`
- `test/unit/config.test.ts`
- `test/unit/prompts.test.ts`
- `test/integration/broker.test.ts`
- `test/integration/hardening.test.ts`
- `test/integration/lifecycle-races.test.ts`
- `test/integration/main-tools.test.ts`
- `test/e2e/real-flow.test.ts`

Then run the shared release commands from the overview.

## Cluster non-goals

- no semantic classifier for whether assistant text answers a request;
- no automatic cancellation of parent or child obligations;
- no new orchestration service;
- no provider restart or redelegation to satisfy a failed request;
- no exactly-once presentation claim without a Pi receipt.
