# pi-email-subagent End-to-End Test Plan

## Purpose

Validate the complete extension boundary: package loading, Pi runtime registration, address/model resolution, durable mail acceptance, background worker creation, priority routing, response obligations, automatic follow-up, concurrency, persistence, lifecycle cleanup, and user-facing observability.

## Test principles

- Deterministic tests use a fake worker transport but the real broker, persistence, prompts, tools, and routing logic.
- SDK construction tests use a real `AgentSession` without making a provider request.
- Runtime smoke tests launch the real `pi` executable in RPC mode and load `src/index.ts` as an extension.
- Tests must not require paid model calls in the default suite.
- A separate live-provider scenario may be run deliberately when credentials and budget are available.
- Every defect found during execution receives a regression test before the fix is considered complete.

## Environments

1. **Automated local/CI:** Node 22+, Pi 0.81.1-compatible peer APIs, temporary persistence directories.
2. **Real runtime smoke:** installed `pi` executable, existing configured main model, no provider request.
3. **Interactive TUI acceptance:** terminal at narrow and normal widths.
4. **Optional live provider:** one registered OpenAI or Kimi model for main and worker.

## Automated scenarios

| ID | Scenario | Expected result | Implementation |
|---|---|---|---|
| E2E-001 | Load extension factory directly | No loader errors; the two email tools plus `inspect_agent`, `wait_for_replies`, `manage_agent`, `/agents`, shortcut, and two renderers are registered | `test/e2e/extension-load.test.ts` |
| E2E-002 | Launch real Pi RPC runtime with extension | Process exits cleanly; `get_state` succeeds; `/agents` is listed; widget integration emits UI requests; no conflicts | `test/e2e/runtime-smoke.test.ts` |
| E2E-003 | Create real SDK worker session | Isolated session starts idle, persists a session file, and disposes without recursive extension conflicts | `test/integration/sdk-worker-start.test.ts` |
| E2E-010 | Send to unknown valid address | Exactly one worker is created and first email is delivered without waiting for work completion | `test/integration/broker.test.ts` |
| E2E-011 | Concurrent sends race to one unknown address | Per-address singleflight creates one worker and batches both accepted requests | `test/integration/parallel-spawn.test.ts` |
| E2E-012 | Send again to existing address | Worker/session is reused and result reports `spawned=false` | `test/integration/broker.test.ts` |
| E2E-013 | Unknown model or malformed address | Request is rejected before journal/spawn | `test/unit/address.test.ts`, broker tests |
| E2E-014 | Agent cap reached | Unknown recipient is rejected before mail acceptance; existing recipients remain routable | `test/integration/broker.test.ts` |
| E2E-020 | High mail to running recipient | Mail is delivered through steering and marked delivered | `test/integration/broker.test.ts` |
| E2E-021 | Low mail to running recipient | Mail remains queued until settlement | `test/integration/broker.test.ts` |
| E2E-022 | Active concurrency cap | Additional worker remains queued while mail acceptance returns immediately; starts when a slot opens | `test/integration/broker.test.ts` |
| E2E-023 | Priority/FIFO mailbox ordering | High requests precede low; FIFO is maintained within priority | `test/unit/mail-store.test.ts` |
| E2E-024 | Cross-agent priority and queue bounds | High pending mail starts before low mail; per-recipient message/byte and batch limits apply | `test/integration/hardening.test.ts` |
| E2E-025 | Sender rate fairness | Invalid mail consumes no quota and per-sender limits do not replace the global bound | `test/integration/hardening.test.ts` |
| E2E-030 | Exact reply subject | Reply atomically reserves, delivers, and closes the referenced request | `test/integration/broker.test.ts`, `test/integration/hardening.test.ts` |
| E2E-034 | Concurrent replies and failed delivery | One concurrent reply wins; terminal delivery failure releases its reservation so a retry can answer | `test/unit/mail-store.test.ts`, `test/integration/hardening.test.ts` |
| E2E-031 | Duplicate/malformed/foreign reply | No unrelated obligation is closed; actionable error is returned | `test/unit/reply.test.ts`, `test/integration/broker.test.ts` |
| E2E-032 | Reply acknowledgement loop prevention | Reply itself has no response obligation; recipient `fetch_emails()` remains empty | `test/integration/broker.test.ts` |
| E2E-033 | `fetch_emails()` formatting | Only delivered unanswered requests appear, with exact ready-to-copy reply subjects | `test/unit/prompts.test.ts`, `test/integration/tools.test.ts` |
| E2E-040 | Worker stops without response | First and final enforcement turns are injected automatically | `test/integration/broker.test.ts` |
| E2E-041 | Repeated enforcement noncompliance | Worker becomes failed and main receives a high-visibility failure notification; broker does not forge a reply | `test/integration/broker.test.ts` |
| E2E-042 | Settlement arrives during enforcement bookkeeping | Settlement is queued and processed rather than lost | Regression coverage in `test/integration/broker.test.ts` |
| E2E-043 | Terminal provider/model error | The original provider error fails the worker and notifies main immediately; no misleading unanswered-mail reminders run | `test/unit/sdk-worker.test.ts`, `test/integration/broker.test.ts` |
| E2E-050 | Mail journal restart | Created, delivered, and answered state reconstruct exactly | `test/unit/mail-store.test.ts` |
| E2E-051 | Broker/session restart | Address restores once; subsequent email reuses the identity | `test/integration/broker.test.ts` |
| E2E-053 | Init/shutdown and restart/send races | Late-created workers are disposed; restart/send leaves exactly one replacement | `test/integration/lifecycle-races.test.ts` |
| E2E-054 | Reduced `maxAgents` and archival | Overflow identities/mail are retained; clean archival frees capacity and preserves context | `test/integration/hardening.test.ts` |
| E2E-052 | Main model/address changes | Old main address remains a valid reply alias while new address is canonical | `test/integration/broker.test.ts` |
| E2E-060 | Project config trust | Project override applies only in trusted projects | `test/unit/config.test.ts` |
| E2E-061 | Effort precedence | Exact address overrides role, which overrides default; mail tools are always retained | `test/unit/config.test.ts` |
| E2E-062 | Prompt etiquette | Main/worker prompts name both tools, require substantive replies, list only routable models, and contain no unregistered static model references | `test/unit/prompts.test.ts` |
| E2E-063 | XML envelope escaping | Peer-controlled subject/body cannot break broker-generated envelope markup | `test/unit/prompts.test.ts` |
| E2E-064 | Model-selection policy | Prompts reserve Terra for simple explicit work, K3 for challenging/web/creative work, Sol for the highest-reasoning work, and prohibit other models absent an explicit user request | `test/unit/prompts.test.ts` |
| E2E-065 | Parent provider inheritance | Isolated worker runtimes inherit an extension-start custom/native provider snapshot and fail early for missing model/auth state | `test/unit/model-runtime.test.ts`, optional live K3 scenario |
| E2E-066 | Side-effect-free inspection | Unknown address preview reports its exact effective profile without spawning or persistence | `test/integration/hardening.test.ts` |
| E2E-067 | Reply join/collection | Multiple request IDs resolve through structured answered/failed/pending states without JSON polling or a separate reply turn | `test/integration/hardening.test.ts`, optional live K3 scenario |
| E2E-068 | Main-only lifecycle tools | Stop/restart/archive/clear-failure exist on main; child sessions do not activate them | `test/integration/main-tools.test.ts`, `test/integration/sdk-worker-start.test.ts` |
| E2E-070 | Sender spoofing | Tool input has no sender field; worker-bound closure supplies identity | `test/integration/tools.test.ts` |
| E2E-071 | Shutdown | Active workers are aborted/paused, disposed, and registry/mail writes flush | Covered by every broker test `finally` plus persistence restart test |
| E2E-080 | Dashboard width safety | Dashboard lines remain within 20/40/60/80/120-column widths with long addresses and activity | `test/unit/ui.test.ts` |

## Interactive TUI acceptance scenarios

### TUI-001 Dashboard discovery

1. Start Pi in this repository and run `/reload-runtime` manually.
2. Verify no extension error appears.
3. Press `Ctrl+Shift+A` and run `/agents` separately.
4. Verify both open the dashboard and Escape closes it.

### TUI-002 Empty and populated status

1. With no agents, verify the widget is absent.
2. Delegate one task.
3. Verify the below-editor widget reports running/queued/unanswered counts.
4. Stop or complete the worker and verify counts update without adding progress messages to model context.

### TUI-003 Dashboard inspection and controls

1. Open `/agents` while two workers are active.
2. Navigate with arrows; inspect detail with Enter and inbox with `i`.
3. Confirm recent assistant text/tool activity is visible but hidden thinking is absent.
4. Compose with `e`, stop with `k`, restart with `r`, archive with `a`, clear stale failure with `x`, and change idle effort with `m`.
5. Confirm archive is rejected for live/obligated agents and effort changes are rejected while running.

### TUI-004 Rendering widths and expansion

1. Repeat at 60, 80, and 120 columns.
2. Verify no rendered line exceeds terminal width.
3. Expand/collapse `send_email`, `fetch_emails`, and incoming email cards.
4. Change theme and verify colors are recomputed.

## Optional live-provider scenario

This scenario is intentionally outside the default suite because it consumes tokens and depends on provider behavior.

1. Start Pi in RPC or TUI mode with a registered OpenAI or Kimi model.
2. Ask main to send one low-priority, read-only request to `scout.live-mail@<registered-model>.com`.
3. Verify the tool returns before the worker result.
4. Observe worker status/activity in `/agents`.
5. Verify the worker calls `fetch_emails()`, performs the task, and sends `Re: [mail-id] ...`.
6. Verify main calls `wait_for_replies` with the returned request ID and receives the reply in that tool result without a separate model turn; the original request disappears from the worker's unanswered mailbox.
7. Send a second request to the same address and confirm context/session reuse.
8. Send a high-priority correction while it runs and verify steering at the next safe boundary.

## Commands

```bash
npm run check
npm test
npm run validate
```

Focused runs:

```bash
npm run test:unit
npm run test:integration
npx tsx --test test/e2e/**/*.test.ts
```

## Exit criteria

- TypeScript check passes with no errors.
- All deterministic unit, integration, SDK construction, and real Pi runtime smoke tests pass.
- No test leaks a Pi subprocess or active worker.
- Every discovered race or lifecycle defect has regression coverage.
- Runtime reload completes with no extension registration conflict.
- Interactive TUI scenarios are either manually confirmed in a real terminal or documented as requiring terminal-only acceptance.

## Validation record

### 2026-07-23

- Pi version: `0.81.1`
- Node version: `v22.19.0`
- `npm run validate`: passed after fixes: 32 tests, 32 passed, 0 failed.
- Real Pi RPC smoke: passed; extension loaded without tool conflicts, `/agents` registered, and widget requests emitted.
- Real SDK worker construction: passed with extensions disabled in the child resource loader.
- Live provider acceptance: passed with `openai-codex/gpt-5.4-mini`. Main called `send_email`, the unknown `scout.live-mail@gpt-5.4-mini.com` worker spawned, called `fetch_emails`, and replied with both virtual tool names. Main received the low-priority custom email reply.
- Package dry run: passed; Pi manifest includes `src/index.ts` and the tarball contains source, README, license, and plans.
- Runtime dependency audit: 0 production vulnerabilities.
- Runtime reload: requested after initial implementation and repeated after final validation.

Defects found and fixed during validation:

1. Concurrent sends could observe a worker inserted before its spawn promise; `ensureWorker` now awaits the per-address singleflight first.
2. A very fast second settlement could arrive during response-enforcement bookkeeping and be dropped; pending settlements are now replayed, with regression coverage.
3. The direct extension loader also returns Pi inline extensions; the smoke assertion now selects the extension by registered tool rather than assuming one total extension.
4. A truncated final JSONL journal line would be ignored once but poison the next restart; initialization now repairs the trailing partial write before appending, with restart coverage.
5. Project role overrides replaced rather than overlaid global role fields; role/address profiles now merge field-by-field.
6. Reviewer defaults included shell access despite a read-only intent; reviewer defaults are now limited to read/search/mail tools.
7. Widget status grouped paused/stopped states as idle; counts now distinguish idle, failed, and paused/stopped.

### 2026-07-24

- `npm run check`: passed.
- `npm test`: passed: 36 tests, 36 passed, 0 failed.
- Custom-provider live acceptance: passed with `openai-codex/gpt-5.6-terra` as main and `kimi-coding/k3` as the email worker while explicitly loading `pi-provider-kimi-code`. The K3 worker fetched its mailbox, replied exactly, and main received the custom email.
- Root cause of the earlier K3 failures: isolated worker `ModelRuntime` instances received the custom Kimi model object but not the parent runtime's extension-registered provider configuration. Workers now inherit registered custom/native providers.
- Terminal model errors are now surfaced directly instead of being misclassified as unanswered-mail noncompliance.

Hardening implementation record:

- `npm run validate`: passed, 72 tests, 72 passed, 0 failed.
- Live provider acceptance passed with `openai-codex/gpt-5.6-terra` as main and `kimi-coding/k3` as worker while loading `pi-provider-kimi-code`.
- Main used the allocated correlation ID with `wait_for_replies`; the K3 reply was returned as one collected tool result.
- Atomic reply reservation/release, cancellation-safe restoration, restart/send serialization, priority scheduling, bounded queues, archival, schemas, escaped framing, effective role tools, and provider fail-fast paths have deterministic coverage.
- `npm audit --omit=dev`: 0 production vulnerabilities. The development graph reports one moderate transitive `protobufjs` advisory.
- Final independent read-only follow-up confirmed all six late lifecycle/capacity/collection/archive/runtime/replay findings resolved, with no remaining material correctness blocker.

Interactive notes:

- Dashboard line-width behavior is automated at 20, 40, 60, 80, and 120 columns.
- Keyboard focus, terminal theme switching, and visual styling still require a human TUI because they depend on an attached terminal; the exact checklist is retained above.
