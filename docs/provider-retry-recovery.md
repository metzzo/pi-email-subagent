# Provider retry visibility and recovery

Pi core owns provider retry classification, attempt limits, backoff, and continuation. `pi-email-subagent` does not add another retry loop, re-prompt a failed run, resend an accepted envelope, restart a worker automatically, switch providers, or replay a prompt batch.

## What the extension shows

For Pi 0.84.2 retry events, the existing bounded Activity path records:

```text
Pi agent retry 1/3 scheduled in 2000ms: WebSocket error
Pi agent retry recovered after attempt 1
```

If Pi exhausts the cycle, Activity records its end before the existing terminal worker failure is committed:

```text
Pi agent retry ended after attempt 3: WebSocket error
```

Retry activity uses the existing `ActivityItem` type and 40-item record limit plus the shared safe-summary boundary. It is cycle status, not a mail outcome. A retrying `agent_end.willRetry=true` does not fail the worker or alert main. Only the final non-retrying assistant error enters `record.failure` and generates one main alert.

Pi 0.84.2's observed order is:

- retryable attempt: assistant error → `agent_end(willRetry=true)` → `auto_retry_start`;
- recovered attempt: successful assistant message → `auto_retry_end(success=true)` → final `agent_end(willRetry=false)` → `agent_settled`;
- exhausted cycle: final `agent_end(willRetry=false)` → `auto_retry_end(success=false)` → `agent_settled`; and
- aborted backoff: `auto_retry_start` → `auto_retry_end(success=false, Retry cancelled)` → `agent_settled`, with no second provider attempt.

`agent_settled` is the one full-run boundary. The worker defers its existing terminal failure emission until that boundary so the preceding unsuccessful retry-end activity is not lost to cleanup.

## Attempt, run, delegation, and obligation terms

These are distinct layers:

- **Provider/SDK attempt:** one request attempt inside a provider client. `retry.provider.maxRetries` belongs here and defaults to `0`.
- **Pi agent retry cycle:** Pi's `auto_retry_*` continuation after a retryable low-level agent run. Activity uses the **Pi agent retry** label.
- **Accepted worker run:** processing of one accepted worker prompt through final `agent_settled`, including Pi-owned retries and tool turns.
- **Delegation:** one response-required `send_email` request assigned to another identity.
- **Mail obligation:** the durable exact mail ID that remains open until a valid correlated reply or explicit administrative cancellation.

Neither a provider attempt nor a Pi agent retry creates another delegation or mail obligation.

## Effective settings

At extension start, a file-backed Pi settings manager loads the actual global/trusted-project documents and reports load errors once by scope. Each worker gets a fresh no-write manager through the supported public `SettingsManager.fromStorage(...)` surface. Pi still performs migration and global/project nested merge; the resource loader and worker session share only that worker-owned manager. Retry, provider retry, transport, HTTP/WebSocket timeouts, compaction/branch summary, shell settings, and thinking budgets preserve Pi's effective trusted behavior. Package/extension/skill/prompt/theme sources are stripped before worker resource reload, so startup cannot install or execute missing packages or inherit main-extension hooks. Untrusted project settings are absent. Steering/follow-up/effort setters—including concurrent effort changes and resumed sessions—write only worker memory, never global or project files.

The extension does not raise Pi defaults. Provider/SDK retries remain at Pi's default `0` unless explicitly configured. Invalid source JSON uses Pi's fallback for that scope and the original bytes are not rewritten.

## Provider option ownership

Long cache retention is selected by provider environment such as `PI_CACHE_RETENTION`, separately from worker settings. Pi 0.84.2 serializes `prompt_cache_retention: "24h"` only when exact effective compatibility metadata allows it, and omits it when `compat.supportsLongCacheRetention` is false. The worker factory rejects drift in every non-secret request model field, including nested sampling parameters, and passes the same prepared runtime plus a detached, deeply frozen model clone from pre-email admission into execution without freezing provider/runtime-owned catalog data. Header-bearing and dynamic OAuth/catalog provider routes fail closed. Native public providers with provider-wide headers, OAuth, refresh hooks, or filter hooks are rejected before worker runtime creation/registration. Demonstrably static registrations reuse the same public object/config, then use public `getAvailable(providerId)` for a post-registration availability/auth check that requires the exact provider/model. This is not an exact internal-refresh receipt. An endpoint that rejects the option needs corrected provider/model metadata and extension reload; the extension never catches the rejection, strips the option, and automatically retries or replays the prompt.

## Safe shared errors and protected native detail

The terminal assistant error is summarized once when it leaves `SdkWorker`. Retry start/end, work-ledger extraction, broker lifecycle/factory/cleanup catches, registry fields, UI, and main alerts use the same idempotent UTF-8 byte/line/control/bidi/markup-boundary with targeted common authorization/header, bearer/key/token, signed-query, and credential-URL redaction. The broker adds only fixed recovery metadata and does not append the same provider cause to Activity again.

Raw assistant provider detail remains in the native worker session Conversation for protected diagnosis; the extension creates no second raw log or artifact. Redaction is bounded risk reduction, not universal secret detection. Do not put credentials in provider error messages, and scrub artifacts before sharing.

## Effects and explicit recovery

Mail state remains authoritative. A terminal worker failure does not answer, cancel, expire, or replace a delivered request. The original stable mail ID and response obligation remain open.

Before recovery, inspect:

1. `/agents` **Work** for current-batch edit/write and unverified shell/custom attempts.
2. `/agents` **Conversation** for the native session's assistant errors, tool calls, and tool results.
3. **Profile/Lifecycle** or `inspect_agent` for provider/model, terminal failure, and open-mail count.

If the current batch contains any mutation, shell, or custom work item—running, succeeded, failed, or interrupted—the UI warns that effects may exist. Shell/custom effects remain unverified. If no such item is recorded, the UI says only that no effect is recorded; this is **not proof of pre-tool failure**. Mailbox tools, restored history, or other external behavior can fall outside the current work summary.

When configuration or provider availability is corrected and recovery is safe, explicitly restart the **same identity** with `manage_agent restart` or `/agents restart`. That reuses its persistent session, provider binding, mailbox, lifecycle, effort, and original mail obligation. Failed recipients keep newly accepted mail queued until that explicit restart. Do not resend the accepted envelope. Never redelegate the same possible-effect scope while its original obligation remains open. If the user abandons the request, stop the recipient and cancel that exact request with a substantive audited reason before assigning any distinct replacement scope.

A live Pi-managed retry may settle. Cleanup is separate: it waits for the exact Pi AgentSession/model/tool/disposal boundary, and a caller deadline never cancels the underlying operation. Only that exact address is blocked while cleanup is genuinely pending; see [Agent lifecycle deadlines](lifecycle.md).

## Attribution and escalation

`fetch failed`, `WebSocket error`, timeouts, and overload text do not establish an extension defect. The cause may be provider service, proxy/DNS/TLS, credentials, quota, endpoint reachability, a Pi provider adapter, or Pi retry lifecycle behavior.

Escalate to Pi core/provider maintainers when a deterministic minimal SDK reproduction shows retry classification contrary to documented `willRetry`, settlement before retry completion, ignored effective settings/options, a repeated completed tool call, inconsistent lifecycle events, or the same transport failure without this extension.

A useful scrubbed artifact contains:

- Pi and `@earendil-works/pi-*` versions;
- provider/model/API identifiers;
- non-secret effective retry/transport/timeout settings;
- ordered structured event types and timestamps;
- `willRetry`, attempt/max/delay, stop reason, and bounded error summary;
- stable session, tool-call, and tool-result IDs/outcomes; and
- whether the mail obligation was answered, open, or explicitly cancelled.

Omit prompts, mail subjects/bodies, credentials, request headers, environment values, hidden reasoning, raw provider payloads, and transport frames. Provider/network remediation is appropriate when the same minimal request fails because of external availability, local networking, credentials, quota, or endpoint behavior without a Pi contract violation.

Retry Activity is persisted through ordinary settlement. A hard crash before settlement may omit a retry start/end from the bounded registry cache; the native worker session's assistant/tool history plus existing mail/failure/work state is the supported postmortem source for this release. No provider-specific durable schema, custom session entry, cache, or migration was added.
