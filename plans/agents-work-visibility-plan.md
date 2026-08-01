# `/agents` Work Visibility Plan

Date: 2026-07-30
Status: implemented — automated gates complete; manual interactive TUI acceptance pending

## Objective

Make `/agents` answer, at a glance and without exposing hidden reasoning:

1. What is each agent doing now?
2. Which files did it explicitly change?
3. What kind and size of change did it make?
4. Did the mutation succeed or fail?
5. Which effects are confidently attributed, and which remain unknown?
6. Are two agents explicitly editing the same file at once?

The interface must prioritize work and mutations over generic tool traffic while remaining honest in the current shared-workspace architecture.

## Current problem

The worker currently flattens every Pi tool event into an `ActivityItem.summary` string:

- `write` and `edit` starts include full content or replacement JSON, which is noisy and truncated.
- completion replaces useful context with only `edit completed` or `write completed`.
- `tool_execution_end.result.details` is discarded even though the built-in edit tool supplies a unified patch, display diff, and first changed line.
- start/end events are not correlated by `toolCallId`.
- reads, searches, mutations, shell commands, and mailbox tools share the same visual category.
- `currentActivity` is one string and may be overwritten by broker delivery status.
- the conversation view renders raw mutation arguments and ignores persisted edit patches in tool-result details.

The result makes reads conspicuous while hiding the outcome that matters: what changed.

## Product principles

### 1. Confidence before cleverness

Use a structural attribution taxonomy:

- **Explicit intent:** an in-flight built-in `edit` or `write` call targeting a known path. It is not yet a confirmed change.
- **Confirmed mutation:** a successful built-in `edit` or `write` completion.
- **Failed mutation:** an `edit` or `write` completion with `isError`; visible, but excluded from change aggregates.
- **Unverified effects:** `bash` and unknown/custom tools. Show the command/tool and outcome, but never claim which files they changed.
- **Inspection:** `read`, `grep`, `find`, and `ls`; collapse into counters instead of competing with mutations.
- **Mailbox/control:** `send_email` and `fetch_emails`; keep in general activity/conversation, not workspace work.

Never promote a bash heuristic to confirmed attribution.

### 2. Event-driven live state, session-backed recovery

Use Pi's worker events for immediate UI state:

- `tool_execution_start` supplies `toolCallId`, tool name, and validated arguments.
- `tool_execution_end` supplies the same ID, success/failure, and structured result details.
- built-in edit results expose `details.patch`, `details.diff`, and `details.firstChangedLine`.

Use persisted session tool calls/results to recover ledger entries after a crash and to load a larger diff on demand. Do not continuously parse session JSONL to drive the live dashboard.

### 3. No shared-workspace attribution guesses

Do not use per-agent `git status`, `git diff`, `fs.watch`, or before/after workspace snapshots as attribution sources. Concurrent agents share one working directory, so those mechanisms can assign another agent's change to the wrong worker.

### 4. Bounded and private by default

- Never duplicate full `write.content` in registry state or dashboard activity.
- Store only path, byte/line counts, status, timing, and a bounded edit-patch preview.
- Keep hidden thinking excluded exactly as today.
- Sanitize terminal control sequences and bound every rendered line.
- Treat patches as sensitive session data and retain existing `0700`/`0600` storage protections.

## Information architecture

## List view

Keep the current three-line density, but replace the generic third line with a work-first summary:

```text
> ● worker.interface@gpt-5.6-sol.com
    running · gpt-5.6-sol · effort high · 12k↑ 3k↓ ctx:40k $0.0412
    now: editing src/ui.ts (12s) · run: 3 files +86/-24 · shell: 2 unverified
```

Priority for `now:`:

1. active explicit mutation;
2. active shell/custom tool with unverified-effects label;
3. broker/runtime activity;
4. idle/last completed work.

For multiple parallel tool calls, show the highest-priority item plus `+N more`.

The aggregate includes only successful explicit mutations from the current accepted prompt batch. Failed edits and shell/custom calls never contribute.

If two active explicit mutations resolve to the same normalized target path, show a warning on both agents and in the header:

```text
⚠ concurrent explicit edit: src/ui.ts (2 agents)
```

This is exact-file collision visibility, not general write-scope conflict detection.

## Detail view

`Enter` opens a work-first detail view:

```text
● worker.interface@gpt-5.6-sol.com
running · openai-codex/gpt-5.6-sol · effort high · writable

Now
> 14:02:11 ✎ edit   src/ui.ts              running 12s

Confirmed and attempted mutations
  14:01:58 ✓ edit   src/types.ts           +6/-2     420ms
  14:01:40 ✗ edit   src/config.ts          failed    oldText not found
  14:00:03 ✓ write  docs/interface.md       4.2 KB · 96 lines

Unverified effects
  13:59:44 ? bash   npm test               ok · 8s · file effects unknown

Inspection this run: 18 reads · 7 searches · 2 listings
```

Rules:

- successful edits show additions/removals parsed from unified patch lines;
- successful writes show bytes and line count, without claiming create vs replace;
- failures show a bounded error and remain visible;
- shell/custom items are visually and structurally separated;
- paths are workspace-relative when inside the workspace and explicitly marked absolute when outside it;
- raw file content and replacement bodies never appear in the default view.

### Keyboard flow

- list: `↑/↓` select agent, `Enter` open detail;
- detail: `↑/↓` select work item, `d` open diff when available;
- `Tab` cycles Work → Activity → Inbox → Profile/Lifecycle;
- `i` jumps directly to Inbox and back;
- `Ctrl+O` opens the existing full conversation;
- `Esc` returns one level, then closes;
- existing compose and management keys remain available and are shown in context-sensitive help.

Pass terminal row count into the dashboard and render within a bounded viewport so detail/history cannot extend past the screen.

## Diff view

A successful edit item with a patch opens a scrollable diff component:

- reuse the conversation component's scroll, page, home/end, pin-to-bottom, refresh, and disposal patterns;
- use Pi's exported `renderDiff()` for theme-compatible added/removed/context colors;
- title includes agent, path, time, and `+A/-R`;
- cap loaded/rendered content at Pi's 50 KB / 2,000-line tool-output guidance;
- on open, upgrade the 8 KB/200-line event preview from the persisted session result when available, bounded to 50 KB/2,000 lines;
- distinguish event-preview truncation from persisted-session truncation without directing the operator to a less complete view;
- `d` or `Esc` closes.

For a just-completed edit whose session tool-result artifact has not yet been appended, use the bounded event-captured preview.

## Conversation view

Improve mutation rendering without turning the conversation into a second dashboard:

- collapse `write` tool-call arguments to `✎ write path · N bytes · N lines`;
- collapse `edit` arguments to `✎ edit path · N replacement blocks`;
- retain compact headers for reads/searches/bash/mail;
- render defensive, bounded `details.patch` or `details.diff` for edit tool results;
- never show thinking blocks;
- never dump full `write.content` by default.

## Telemetry and data model

Add structured, derived work state alongside legacy activity for compatibility.

```ts
type WorkKind = "edit" | "write" | "shell" | "custom";
type WorkStatus = "running" | "succeeded" | "failed" | "interrupted";
type WorkAttribution = "explicit" | "unverified";

interface WorkItem {
  toolCallId: string;
  batchId: number;
  toolName: string;
  kind: WorkKind;
  attribution: WorkAttribution;
  status: WorkStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  path?: string;
  displayPath?: string;
  commandPreview?: string;
  error?: string;
  bytesWritten?: number;
  linesWritten?: number;
  linesAdded?: number;
  linesRemoved?: number;
  firstChangedLine?: number;
  patchPreview?: string;
  patchTruncated?: boolean;
}

interface WorkCounters {
  reads: number;
  searches: number;
  listings: number;
}

interface AgentWorkState {
  nextBatchId: number;
  currentBatchId?: number;
  batchStartedAt?: string;
  batchEndedAt?: string;
  active: WorkItem[];
  recent: WorkItem[];
  inspection: WorkCounters;
}
```

### Batch semantics

A batch is one accepted idle `prompt()` delivery, including automatic provider retries and mailbox-enforcement turns belonging to that prompt. `steer()` remains part of the current batch. Starting a new idle prompt:

- increments `nextBatchId`;
- clears current inspection counters;
- marks impossible stale active entries interrupted;
- retains the bounded recent history.

The list aggregate is for the current/latest batch, while detail can show bounded prior entries.

### Tool lifecycle

On `tool_execution_start`:

- `edit`: create active explicit-intent item with path and edit-block count only;
- `write`: create active explicit-intent item with path, UTF-8 byte count, and line count; never retain content;
- `bash`: create active unverified item with a sanitized, bounded command preview;
- `read|grep|find|ls`: increment inspection counters only;
- mailbox tools: leave to general activity;
- unknown/custom tools: create an unverified item with bounded argument-derived target hints only when safe; otherwise tool name only.

On `tool_execution_end`:

- correlate by `toolCallId`;
- synthesize a defensive orphan item if the start was not observed;
- for successful edit, parse `result.details.patch` defensively, calculate `+/-`, first changed line, and bounded preview;
- for successful write, keep start-time size metadata;
- for failures, store a bounded error extracted from result content and exclude from aggregates;
- for shell/custom, record outcome and duration while preserving `unverified` attribution;
- move completed item from `active` to `recent` and emit a structured worker event.

Do not consume `tool_execution_update` in the first release.

## Bounds and persistence

Constants:

- maximum 48 completed work items per agent;
- active items are never evicted while running;
- maximum 8 KB and 200 lines per stored patch preview;
- maximum 240 characters for command preview;
- maximum 500 characters for error summary;
- no stored write content;
- no stored read/search results.

`AgentRecord.work` is an optional derived cache field on disk:

- registry parser defaults absent work state for legacy records;
- parser validates enums, timestamps, counts, bounds, and duplicate tool-call IDs;
- load-time trimming protects against oversized/crafted state;
- no registry version bump is required because the field is optional and derived.

Persist work at mutation completion, batch settlement, stop/restart/archive, and shutdown. Throttle/coalesce completion persistence so parallel tool completions do not create write storms.

## Crash and restart recovery

The session file remains the durable source of truth for completed tool calls:

1. On restoration, mark any registry `active` entries as `interrupted`; never show them as currently running.
2. Parse the active session branch once, bounded by existing session parsing safeguards.
3. Correlate assistant tool-call blocks with tool-result messages by `toolCallId`.
4. Reconstruct missing successful/failed edit and write ledger items, including edit patch statistics.
5. Deduplicate by `toolCallId` and retain registry timestamps when already present.
6. If reconstruction fails, retain the last valid ledger and expose a non-fatal diagnostic; do not block worker restoration.

Recovery must never infer bash filesystem effects.

## Implementation phases

## Phase 1 — Structured worker telemetry

Files:

- `src/types.ts`
- `src/sdk-worker.ts`
- `src/util.ts` or a new focused `src/work-ledger.ts`
- `src/broker.ts`
- `src/registry-store.ts`
- `test/unit/sdk-worker.test.ts`
- `test/unit/registry-store.test.ts`
- new focused work-ledger unit tests

Deliver:

- pure tool classification, path display, patch-stat, capping, and aggregation helpers;
- batch tracking and start/end correlation;
- structured worker events and broker synchronization;
- bounded persistence and legacy defaults;
- completion persistence coalescing;
- restart handling for stale active items.

Acceptance:

- full write/edit content never enters activity or registry;
- successful edit patch stats are exact;
- failed edits do not count as changes;
- bash/custom items cannot enter confirmed aggregates;
- parallel tool calls correlate correctly by ID and completion order;
- all parsing is defensive against overridden tool result shapes.

## Phase 2 — Work-first dashboard

Files:

- `src/ui.ts`
- `src/main-tools.ts` if inspection should expose summarized work state
- `test/unit/ui.test.ts`

Deliver:

- list `now` and current-batch aggregate line;
- writable badge;
- work-first detail layout with selection and bounded viewport;
- Activity/Inbox/Profile tabs;
- context-sensitive key hints;
- exact-path active conflict warning;
- one-line below-editor widget enrichment when an explicit mutation is active.

Acceptance:

- operator can identify active path and successful changed paths without opening conversation;
- width tests pass at 20, 40, 80, and 120 columns;
- no rendered line exceeds width;
- many work entries stay inside terminal viewport;
- hidden thinking and raw content remain absent.

## Phase 3 — Diff and conversation views

Files:

- `src/ui.ts` or new `src/work-ui.ts`
- `test/unit/conversation-ui.test.ts`
- `test/unit/ui.test.ts`

Deliver:

- selectable diff view using `renderDiff()`;
- event preview plus on-demand session patch lookup;
- compact mutation call headers;
- bounded edit result rendering;
- no default full-write content dump.

Acceptance:

- `d` opens the selected edit patch and scrolls correctly;
- just-completed and restored edits both display;
- truncation is explicit;
- conversation still renders all visible roles and never thinking.

## Phase 4 — Recovery, documentation, and end-to-end proof

Files:

- session/work recovery helper
- `src/broker.ts`
- `README.md`
- `docs/README.md`
- new `docs/agents-dashboard.md` or expanded UI documentation
- `CHANGELOG.md`
- recovery and real scripted-provider tests

Deliver:

- bounded session-ledger reconstruction;
- docs for confidence taxonomy and shared-workspace limitation;
- deterministic real Pi RPC scenario where a scripted worker edits and writes files and `/agents`-backing snapshot reports them;
- manual TUI acceptance checklist.

Acceptance:

- crash after durable tool result but before registry persistence recovers the work item;
- legacy registry loads with empty work state;
- two agents editing the same explicit path show a warning without attributing bash changes;
- required tests make no paid provider calls.

## Deterministic validation matrix

### Unit

- tool classification table;
- write byte/line counting with multibyte content;
- edit patch `+/-` parsing excluding `+++`/`---` headers;
- malformed/missing result details;
- failure content extraction;
- path sanitization and inside/outside-workspace display;
- patch/command/error caps;
- ledger eviction with active-item protection;
- aggregate deduplication by file and batch;
- bash/custom unverified invariants;
- legacy and malformed registry parsing;
- responsive render widths and viewport bounds;
- diff scrolling and closure;
- thinking and raw-write-content privacy.

### Integration

- parallel edit/write/read/bash calls complete out of order;
- work completion persists without a state transition;
- crash recovery reconstructs a missing item from session JSONL;
- restart marks stale active work interrupted and installs a fresh batch;
- concurrent same-path explicit mutations produce a warning;
- mutation persistence coalesces without losing the final state.

### Real scripted-provider RPC

- worker performs read → edit → write → bash;
- broker snapshot distinguishes inspection, confirmed mutation, and unverified effects;
- existing `/agents` command still loads and closes cleanly;
- no paid models.

### Manual TUI

- narrow (40-column), normal (100-column), and tall/short terminals;
- live mutation transitions running → succeeded/failed;
- diff open/scroll/close;
- Activity/Inbox/Profile navigation;
- two-agent same-file warning;
- theme invalidation and terminal control sanitization.

## Non-goals

- attributing filesystem effects of bash or arbitrary custom tools;
- per-agent `git diff` attribution in a shared workspace;
- filesystem watchers for ownership inference;
- full declared write-scope conflict detection;
- worktree/process isolation;
- showing hidden reasoning;
- retaining full written file contents in registry state;
- replacing the conversation viewer.

These belong to later isolation/write-scope milestones. This plan provides honest visibility with the evidence Pi already supplies.

## Release gate

Implementation is complete only when:

- every successful explicit mutation is visible by path and outcome;
- active mutation intent is visibly distinct from confirmed completion;
- failed mutations never inflate aggregates;
- bash/custom effects are always labeled unverified;
- raw write contents are absent from activity, registry work state, and default dashboard/conversation rendering;
- recovery reproduces completed durable mutations without false attribution;
- dashboard lines and rows remain bounded;
- deterministic suites, package smoke, production audit, and repeated UI/lifecycle races pass.
