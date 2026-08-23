# `/agents` work dashboard

`/agents` (or `Ctrl+Shift+A`) is a work-first view of persistent workers. It shows explicit file mutation intent and confirmed built-in edit/write outcomes without exposing hidden reasoning or written/replacement bodies.

For a simpler operator-facing lifecycle, paused, stopped, and archived identities are all labeled **closed** in the dashboard and Agents widget. Their distinct internal states and management behavior remain unchanged in tools, persisted records, and APIs. The Profile/Lifecycle tab shows the exact internal state needed for recovery.

The dashboard header and one-line Agents widget show current derived **identity capacity** (activation leases used/`maxAgents`) separately from **run slots** (active runs/`maxConcurrent`). A full header warns to reuse/restart relevant work and archive only a clean identity; stop retains its lease. These values come from current broker sets and are not persisted as a second ledger.

## Confidence model

- **Running edit/write:** explicit mutation intent. It is not confirmed until the built-in tool succeeds.
- **Confirmed:** the built-in `edit` or `write` call reported success. This is evidence about that call, not exclusive authorship or proof that the file still has that final content. Edits show patch `+/-` statistics when supplied; writes show UTF-8 bytes and logical line count when known.
- **Failed:** a failed edit/write remains visible but is excluded from run aggregates.
- **Unverified:** `bash` and custom tools show their bounded command/target hint and outcome, but their file effects are always unknown.
- **Inspection:** reads, searches, and listings collapse into current-run counters.

This is structural attribution only. Workers share a workspace, so the extension deliberately does not use git status, filesystem watchers, snapshots, or worktrees to guess ownership. A warning appears when two agents have active explicit mutation intent for the same normalized exact path. Existing targets and their nearest existing parents are canonicalized through realpath where possible; unresolved aliases make this warning best-effort. It is not a write-scope or semantic conflict detector.

## Navigation

### Agent list

- `↑` / `↓`: select
- `Enter`: open detail
- `Ctrl+O`: visible recorded conversation
- `i`: open Inbox
- `e`, `k`, `r`, `a`, `x`, `m`: compose, stop, restart, archive, clear failure, change effort
- `/agents cancel <request-id> <reason>`: durably close an intentionally abandoned Inbox obligation after its recipient is inactive
- `Esc`: close

The third row prioritizes active edit/write intent, then unverified shell/custom work, then runtime activity. Its run aggregate includes successful explicit mutations only. Pi-managed provider retry scheduling and recovery appear as ordinary bounded runtime activity; they do not turn the row red, mark the identity failed, or change mail state.

### Detail

`Tab` cycles Work, Activity, Inbox, and Profile/Lifecycle. `i` jumps to Inbox and back. Inbox shows the exact request IDs needed by `cancel_request` or `/agents cancel`; cancellation requires an inactive recipient, explicit abandonment, and a substantive audit reason. Profile/Lifecycle shows the selected identity's persisted provider/model binding, whether it is preserved or unavailable without substitution, exact internal state, lease held/free, global identity/run use, incoming/outgoing/queued/pending counts, archive eligibility, and a safe recovery hint. For a terminal agent-run failure, Profile also shows provider/model, the external-or-unclear attribution boundary, delivered unanswered count, and a current-batch effects warning. An empty work ledger is labeled not proven safe. In Work, use `↑` / `↓` to select an item and `d` to open a successful edit patch. `Esc` returns to the list.

The diff view is scrollable with arrows, Page Up/Down, Home/End, and closes with `d` or `Esc`. The live event preview is bounded to 8 KB/200 lines; opening it upgrades from the persisted session result when available, bounded to 50 KB/2,000 lines. Truncation notes distinguish the two sources. Dashboard rows and every terminal line are viewport/width bounded.

## Durability and privacy

The registry keeps a derived cache of at most 48 completed items, 240-character commands, 500-character errors, and bounded patch previews. It never stores `write.content`, edit replacement bodies, or read/search results. On restart, stale active calls become interrupted and durable edit/write tool calls/results are reconstructed once from the active session branch. Recovery diagnostics are non-fatal.

The visible conversation view collapses write/edit arguments and shows bounded edit patches. Thinking blocks, raw mutation bodies, and content beyond configured caps remain excluded. Native assistant errors and tool call/result history remain the detailed provider-retry postmortem source. Capacity/retry headers, the widget, and Profile contain only aggregate counts/state and never add mail subjects, bodies, or unrelated address lists; sensitive selected-mail excerpts remain confined to Inbox.

See [Provider-aware durable model routing](provider-aware-model-routing.md) for binding/unavailability semantics and [Provider retry visibility and recovery](provider-retry-recovery.md) before an explicit restart after terminal failure.

## Manual acceptance checklist

- Try 40- and 100-column terminals and short/tall viewports.
- Observe edit/write transition from running intent to succeeded or failed.
- Open, scroll, and close an edit diff.
- Cycle all four detail tabs and open/close the full conversation.
- Run two workers against the same exact path and verify both warnings.
- Run bash and verify it remains labeled unverified.
- Switch themes and confirm colors invalidate cleanly.
