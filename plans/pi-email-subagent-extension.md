# Pi Email Subagent Extension

## Summary

Build `pi-email-subagent`, a Pi extension for running persistent subagents concurrently and coordinating them through virtual email. It should feel similar to background agents in Claude Code: delegation returns immediately, work continues in parallel, activity remains easy to inspect, and completed or blocking results arrive in the main thread without polling.

The extension exposes two tools to the main agent and every subagent:

```text
send_email(to, subject, message, priority)
fetch_emails()
```

Email is the only agent-creation and coordination primitive. Sending to an unknown valid address creates the recipient; sending to an existing address reuses its isolated session and context.

## Product goals

- Run multiple subagents concurrently without blocking the main agent.
- Give every subagent an isolated, persistent Pi context.
- Let the user select a registered model through the email address and configure effort independently.
- Make active work, recent tool calls, mailbox state, usage, and failures easy to inspect.
- Support high-priority steering and low-priority follow-up delivery.
- Ensure every delegated request receives a substantive email response.
- Persist worker sessions and mailbox state across reloads and parent-session resumes.
- Keep the protocol small enough that models use it reliably.

## Non-goals for the first version

- Sending real network email.
- Running agents on remote machines.
- Automatically merging changes from parallel Git worktrees.
- Rewinding live workers when the main conversation navigates its session tree.
- Letting arbitrary project configuration execute before Pi project trust is established.
- Exposing provider reasoning or hidden thinking in the dashboard.

## Intended user experience

The main agent can issue sibling tool calls such as:

```text
send_email(
  "scout.map-auth@kimi-for-coding-highspeed.com",
  "Map the authentication flow",
  "Find the entry points, important files, and tests. Do not modify files.",
  "low"
)

send_email(
  "reviewer.audit-auth@gpt-5.4.com",
  "Audit refresh-token handling",
  "Review concurrency and token-reuse risks. Return concrete findings with paths.",
  "low"
)
```

Both calls return after their mail is accepted. The main agent remains free to continue working while the recipients run concurrently.

The normal interaction should look like:

```text
✉ scout.map-auth@kimi-for-coding-highspeed.com [LOW]
  ✓ delivered · spawned · effort low

✉ reviewer.audit-auth@gpt-5.4.com [LOW]
  ✓ delivered · spawned · effort high

Agents: 2 running · 0 idle · 2 open requests
```

A low-priority result is delivered after the main agent finishes its current work. A high-priority blocker is steered into the main context at the next safe boundary.

## Core design decisions

1. **Background rather than blocking.** `send_email` acknowledges enqueue/spawn; it never waits for recipient completion.
2. **Mail is the creation API.** There is no separate model-facing `spawn_agent` tool.
3. **Persistent identities.** An exact email address identifies one worker session for the lifetime of the parent Pi session.
4. **In-process SDK workers for v1.** Each worker uses an `AgentSession`; a transport interface leaves room for RPC subprocess workers later.
5. **Durable broker state.** Mail is journaled before delivery is acknowledged.
6. **Broker-owned identity.** The sender is bound to the calling session and cannot be supplied or spoofed by tool arguments.
7. **Two priority levels only.** High means steer at the next safe boundary; low means wait until settled.
8. **Explicit response obligations.** Request IDs and reply subjects let the broker determine what remains unanswered.
9. **Bounded parallelism.** All work is accepted immediately, but only a configurable number of workers actively run at once.
10. **Controlled child resources.** Worker sessions load project context and explicitly allowed tools without recursively loading the parent extension.

## Model and effort selection

The model comes from the address suffix. The broker validates it against Pi's live registered model catalog before spawning. Invalid or unavailable model domains produce an error and do not create an agent.

Effort is intentionally not encoded in the address. It resolves in this order:

1. Exact address override created in `/agents` or configuration.
2. Role profile matching the address `name` component.
3. Configured default effort.

The selected effort is shown in the spawn result, dashboard, and subagent identity prompt. It uses Pi's normal levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, clamped to the selected model's capabilities.

## High-level architecture

```text
Main Pi extension
  ├── Extension entrypoint
  │   ├── registers send_email and fetch_emails
  │   ├── injects the main coordination prompt
  │   ├── registers commands, renderers, and shortcut
  │   └── binds session lifecycle events
  └── AgentBroker
      ├── AddressRouter
      ├── MailStore
      ├── WorkerManager
      │   └── AgentWorker[]
      │       ├── isolated AgentSession
      │       ├── persistent SessionManager
      │       ├── send_email/fetch_emails custom tools
      │       └── event subscription
      ├── PromptBuilder
      ├── ActivityStore
      └── UIController
```

### Extension entrypoint

The entrypoint owns integration with the main Pi session:

- Register the two tools for the main model.
- Append shared mailbox and main-coordinator instructions in `before_agent_start`.
- Track the current main model and canonical `main@<model>.com` address.
- Route worker-to-main mail through `pi.sendMessage` using `steer` or `followUp` delivery.
- Start and dispose the session-scoped broker on `session_start` and `session_shutdown`.
- Register `/agents`, the dashboard shortcut, custom tool renderers, and incoming mail renderer.

All asynchronous callbacks must be guarded by a broker generation token so they cannot use stale Pi contexts after reload, resume, new-session, fork, or clone replacement.

### AgentBroker

The broker is the only component allowed to create workers or mutate mailbox state. Its responsibilities are:

- Validate and canonicalize addresses.
- Assign immutable sender identity and email IDs.
- Parse reply subjects and manage response obligations.
- Persist an envelope before acknowledging `send_email`.
- Atomically create an unknown recipient exactly once.
- Schedule workers within concurrency and budget limits.
- Deliver high and low mail with the correct semantics.
- Enforce response behavior when a worker settles.
- Publish state changes to the UI and persistence layers.

### AgentWorker

A worker wraps one Pi SDK `AgentSession`. It stores:

- Email address, task slug, model ID, effort, role profile, and enabled tools.
- Current state: `queued`, `spawning`, `running`, `idle`, `failed`, `stopped`, or `paused`.
- Persistent session file and last activity timestamp.
- Current tool call and a bounded recent activity feed.
- Usage, cost, and context-window estimates.
- Inbox counts and enforcement-attempt count.

Every worker gets custom `send_email` and `fetch_emails` tools whose closures bind the worker's address. Workers share the parent working directory in v1, but not conversation context.

### Worker transport abstraction

Use an interface such as:

```ts
interface WorkerTransport {
  start(config: WorkerConfig): Promise<void>;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  getState(): WorkerState;
  subscribe(listener: (event: WorkerEvent) => void): () => void;
}
```

The first implementation uses `AgentSession` directly. A future implementation can use long-lived `pi --mode rpc` subprocesses for process isolation without changing mail, persistence, prompts, or UI.

## Detailed email protocol and prompts

### Address contract

Subagent addresses use:

```text
<name>.<task-slug>@<model>.com
```

Examples using currently registered models:

```text
scout.map-auth@kimi-for-coding-highspeed.com
reviewer.audit-auth@gpt-5.4.com
worker.fix-tests@k3.com
planner.design-cache@gpt-5.5.com
```

The main Pi thread is the exception:

```text
main@gpt-5.4.com
```

Rules:

- `name` and `task-slug` are lowercase kebab-case.
- The model portion must exactly match a registered model.
- The broker dynamically inserts registered models into the prompt; agents must not invent model names.
- Sending to an unknown but valid address spawns that agent.
- Sending again to the same address reuses its session and context.
- A subagent’s model is immutable. Use a new address to use another model.
- Effort is configured through `/agents` or an address/task profile before first delivery. It is shown in the agent’s identity prompt but not encoded in the address.
- If the main thread changes models, its new `main@<model>.com` address becomes canonical, while previous main addresses remain routing aliases.

Current routable model names should be generated dynamically. In this environment they are:

```text
k3
kimi-for-coding
kimi-for-coding-highspeed
gpt-5.3-codex-spark
gpt-5.4
gpt-5.4-mini
gpt-5.5
gpt-5.6-luna
gpt-5.6-sol
gpt-5.6-terra
```

### Reply tracking

Every request email receives an ID:

```text
mail_01JQ8M...
```

A response must use this exact subject format:

```text
Re: [mail_01JQ8M...] Original subject
```

This lets `send_email` mark the referenced message as answered without adding another tool parameter.

Important semantics:

- New emails are response-required requests.
- `Re: [mail-id] ...` emails are replies and do not themselves require an acknowledgement.
- A reply should only answer the referenced email.
- If the reply introduces new work or asks a new question, send that as a separate new email.
- This prevents infinite acknowledgement loops.

### Tool definitions

#### `send_email`

```text
send_email(to, subject, message, priority)
```

Suggested tool description:

> Send a virtual email to another Pi agent. The sender is automatically set to your own agent address. If `to` is a valid address that does not exist, the broker spawns it using the model encoded in its address. Use `priority="high"` only for blockers or information that should alter ongoing work. Use `priority="low"` for normal requests and completed results. To answer an email, copy its provided reply subject exactly: `Re: [mail-id] original subject`. A successful reply marks that email answered.

The tool result should be explicit:

```text
Email delivered.
ID: mail_01JQ...
To: reviewer.audit-auth@gpt-5.4.com
Priority: low
Spawned recipient: yes
Answered email: none
```

For a valid reply:

```text
Email delivered.
ID: mail_01JR...
To: main@gpt-5.4.com
Priority: low
Answered email: mail_01JQ...
```

For a malformed reply:

```text
Email delivered as a new request, but it did not answer any outstanding email.
Use the exact reply subject returned by fetch_emails().
```

#### `fetch_emails`

```text
fetch_emails()
```

Suggested tool description:

> Return all response-required emails in your mailbox that have not been answered successfully. Emails are ordered by priority and arrival time. Call this when beginning mailbox-driven work and immediately before finishing. For each email, the result includes the exact recipient and subject to use with `send_email`.

Example result:

```text
UNANSWERED EMAILS (2)

[1]
ID: mail_01JQ8M
From: main@gpt-5.4.com
Priority: high
Subject: Check refresh-token race
Reply subject: Re: [mail_01JQ8M] Check refresh-token race
Received: 2026-03-21T12:14:02Z

Review the refresh-token rotation code and determine whether two
concurrent requests can reuse the same token.

[2]
ID: mail_01JQ91
From: scout.map-auth@kimi-for-coding-highspeed.com
Priority: low
Subject: Confirm middleware entry point
Reply subject: Re: [mail_01JQ91] Confirm middleware entry point
Received: 2026-03-21T12:15:41Z

Is authMiddleware the only entry point?
```

### Inbound email context format

Emails injected into context should be machine-distinct:

```xml
<agent-email
  id="mail_01JQ8M"
  kind="request"
  priority="high"
>
  <from>main@gpt-5.4.com</from>
  <to>reviewer.audit-auth@gpt-5.4.com</to>
  <subject>Check refresh-token race</subject>
  <reply-subject>Re: [mail_01JQ8M] Check refresh-token race</reply-subject>
  <body>
    Review the refresh-token rotation code and determine whether two
    concurrent requests can reuse the same token.
  </body>
</agent-email>
```

Replies use `kind="reply"` and include `in-reply-to`. They do not include a reply obligation.

### Shared mailbox system prompt

Append this to both the main and subagent system prompts:

```markdown
## Virtual Agent Email

Your email identity is:

- Address: `{{address}}`
- Model: `{{model_id}}`
- Effort: `{{effort}}`

You can communicate with other agents using:

- `send_email(to, subject, message, priority)`
- `fetch_emails()`

### Valid addresses

Subagents use:

`<name>.<task-slug>@<model>.com`

The main Pi thread uses:

`main@<model>.com`

Only use a model listed below:

<available-email-models>
{{routable_model_ids}}
</available-email-models>

Never invent or guess a model name. If the desired model is not listed, do
not construct an address for it.

Sending an email to a valid address that does not yet exist creates that
agent. Sending to an existing address reuses its persistent context.

### Delivery priority

- `high`: blockers, corrections, or discoveries that should affect ongoing
  work. High-priority mail is delivered at the next safe agent boundary.
- `low`: ordinary delegation, completed results, and non-urgent information.
  Low-priority mail waits until the recipient finishes its current work.

Use `low` by default. Do not use `high` merely to make your message noticed.

### Email etiquette

1. Every response-required email must receive a substantive response.
2. At the start of mailbox-driven work, call `fetch_emails()`.
3. Before becoming idle, call `fetch_emails()` again.
4. Reply to the address in the email's `From` field.
5. Copy the provided reply subject exactly:
   `Re: [mail-id] original subject`.
6. Do not claim that you replied unless `send_email` succeeded.
7. A bare acknowledgement such as "received" is not an adequate response.
8. A valid response must contain one of:
   - the requested result,
   - a clear partial result and remaining work,
   - a blocker and the information needed to continue,
   - a concise explanation of why the request cannot be completed.
9. Replies answer the referenced email and do not require acknowledgements.
10. Do not put new requests inside a reply. Send each new request as a
    separate email with a new subject.
11. Do not send progress mail merely for observability; the UI already shows
    your activity. Send mail when another agent needs the information.
12. Do not spawn agents frivolously or create multiple addresses for the same
    continuing task.

Your ordinary assistant text is not a substitute for email. Other agents
cannot be assumed to see your transcript. When an email requested work, send
the result through `send_email`.
```

### Main-thread coordinator prompt

Append this in addition to the shared prompt:

```markdown
## Main Agent Coordination

You are the main Pi thread. Your current email address is:

`{{main_address}}`

Use subagents when independent investigation, review, or implementation can
proceed concurrently.

When creating a subagent address:

1. Choose a short role-oriented name.
2. Choose a task slug describing the persistent responsibility.
3. Select only a model from `<available-email-models>`.
4. Use the exact form `<name>.<task-slug>@<model>.com`.

Examples of valid structure:

- `scout.map-auth@kimi-for-coding-highspeed.com`
- `reviewer.audit-auth@gpt-5.4.com`
- `worker.fix-tests@k3.com`

A delegation email must be self-contained. Include:

- the objective,
- relevant paths or known context,
- constraints,
- whether file changes are allowed,
- the expected response,
- any validation the agent should perform.

Use low priority for normal delegation. Because a nonexistent recipient is
idle, low-priority mail still starts it immediately.

After delegating, continue other useful work instead of polling. Results will
arrive by email.

When an agent sends a new high-priority request or blocker, answer it
promptly. Before presenting your final answer to the user, call
`fetch_emails()` and handle any outstanding response-required mail relevant
to the current task.
```

### Subagent prompt

Every spawned worker should receive this prompt:

```markdown
## Subagent Role

You are a persistent Pi subagent.

- Your address: `{{agent_address}}`
- Your task slug: `{{task_slug}}`
- Your model: `{{model_id}}`
- Your effort: `{{effort}}`
- Main thread: `{{main_address}}`

You work from requests delivered through your virtual mailbox. Your
transcript is private to your session; the requester cannot be assumed to see
your assistant output or tool results.

### Required workflow

For every work cycle:

1. Call `fetch_emails()`.
2. Read all unanswered emails before choosing work.
3. Handle high-priority requests before low-priority requests.
4. Perform the requested investigation or changes.
5. Send a substantive reply for every request you handled.
6. Use each email's exact `Reply subject`.
7. Call `fetch_emails()` again before stopping.
8. Do not become idle while an email remains unanswered.

If you cannot finish the requested work, you must still reply. State:

- what you completed,
- what remains,
- why you are blocked,
- what the requester should do next.

Do not merely print a result in assistant text. The result must be sent with
`send_email`.

### Delegating further work

You may email another agent when a genuinely independent task can run in
parallel. Use a valid address of the form:

`<name>.<task-slug>@<model>.com`

Only use a model listed in `<available-email-models>`.

When delegating:

- make the request self-contained,
- use low priority by default,
- remember that you are responsible for responding to your own requester,
- do not wait indefinitely for another agent if you can report a useful
  partial result.

Before stopping, verify with `fetch_emails()` that your unanswered count is
zero.
```

### Automatic response enforcement

“Stopped” should mean Pi’s `agent_settled` event, not the end of an individual model turn.

When a subagent settles:

1. The broker checks its unanswered mailbox directly.
2. If unanswered requests exist, it immediately starts another turn with this prompt.
3. If it settles again without replying, send one stricter retry.
4. After repeated noncompliance, mark the agent as failed and notify the main thread rather than forging a response.

First enforcement prompt:

```markdown
<mailbox-enforcement>
You attempted to become idle with {{count}} unanswered email(s).

You must respond before stopping.

Call `fetch_emails()` now. For every returned email, send a substantive
response using `send_email` and the exact provided reply subject.

Do not merely describe what you would send. Make the tool calls.

If the requested work is incomplete, send a partial-result or blocker
response. An incomplete but honest response is acceptable; silence is not.
</mailbox-enforcement>
```

Second enforcement prompt:

```markdown
<mailbox-enforcement level="final">
You still have unanswered email obligations after a previous reminder.

Call `fetch_emails()` and send a valid response for every returned email now.
Use the exact reply subjects. Do not perform unrelated work and do not stop
before the `send_email` tool calls succeed.
</mailbox-enforcement>
```

This makes replying a concrete, broker-enforced lifecycle rule rather than relying only on prompt compliance.

## Data model

### Email envelope

```ts
type EmailPriority = "high" | "low";
type EmailKind = "request" | "reply";
type DeliveryState = "queued" | "delivered" | "failed";

interface EmailEnvelope {
  id: string;
  from: string;
  to: string;
  subject: string;
  message: string;
  priority: EmailPriority;
  kind: EmailKind;
  inReplyTo?: string;
  requiresResponse: boolean;
  createdAt: string;
  deliveredAt?: string;
  answeredAt?: string;
  answeredBy?: string;
  deliveryState: DeliveryState;
  error?: string;
}
```

Rules:

- IDs should be sortable and collision-resistant, such as a prefixed ULID.
- A syntactically valid `Re: [mail-id]` marks `kind="reply"` and links `inReplyTo`.
- The referenced request is marked answered only after the reply is durably accepted.
- Replies set `requiresResponse=false`; requests set it to `true`.
- A malformed or foreign reply ID is rejected or clearly delivered as a new request—never silently treated as an answer.
- Message bodies and subjects have configurable byte limits and use UTF-8.

### Agent record

```ts
interface AgentRecord {
  address: string;
  name: string;
  taskSlug: string;
  modelId: string;
  effort: string;
  tools: string[];
  state: "queued" | "spawning" | "running" | "idle" | "failed" | "stopped" | "paused";
  sessionFile?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  currentActivity?: string;
  failure?: string;
}
```

### Broker invariants

- One exact canonical subagent address maps to at most one worker.
- Mail is persisted before a successful tool result is returned.
- Mail from the same sender is FIFO within a priority.
- High mail may overtake low mail.
- A recipient is created at most once even when sibling `send_email` calls race.
- A reply can answer only an existing request addressed to its sender.
- Stale worker callbacks cannot mutate a replacement main session.

## Runtime lifecycle

### Extension startup

On `session_start`:

1. Create a broker namespace from the main session ID.
2. Load global configuration and trusted project overrides.
3. Open or reconstruct the registry and mail journal.
4. Determine the main address from the current model.
5. Restore prior main aliases.
6. Reopen persisted worker sessions in `paused` or `idle` state.
7. Requeue mail that was durably accepted but not confirmed delivered.
8. Install the widget/status display.

Workers should not begin network/model work inside the extension factory. Background resources start only after `session_start` and are cleaned up idempotently during `session_shutdown`.

### Sending mail

`send_email` performs:

1. Validate parameters and size limits.
2. Resolve the caller-bound sender.
3. Parse and canonicalize the recipient.
4. Verify that the model domain is currently routable.
5. Parse `Re: [mail-id]` and validate the referenced request.
6. Create and durably append the envelope.
7. Use a per-address singleflight operation to find or create the recipient.
8. Queue delivery based on recipient state and priority.
9. Return the envelope ID, spawn status, recipient model/effort, and answered request ID.

The tool should return quickly after step 8. Worker completion is never awaited.

### Spawning a worker

For a new valid address:

1. Resolve the model from the domain.
2. Resolve effort, role profile, instructions, and tool allowlist.
3. Enforce global agent and active-worker limits.
4. Create a persistent `SessionManager` in the broker namespace.
5. Build a controlled resource loader that includes relevant context files and skills but excludes recursive loading of `pi-email-subagent`.
6. Define worker-bound `send_email` and `fetch_emails` tools.
7. Create the `AgentSession` with the selected model, effort, tools, and prompt.
8. Subscribe to message, tool, usage, queue, error, and settled events.
9. Mark the worker idle and dispatch its first queued email.

If the active concurrency limit is reached, the worker remains `queued`; its email is accepted and visible in the dashboard.

### Delivery semantics

For subagents:

- Idle recipient: prompt immediately with the formatted email envelope.
- Running recipient plus high mail: call `steer()` so it appears at the next safe boundary.
- Running recipient plus low mail: queue broker-side and deliver after the current run settles.
- Multiple pending high emails at one boundary may be delivered in one ordered batch.
- Multiple low emails may be delivered together after settlement to reduce unnecessary model turns.

For the main Pi thread:

- High mail uses `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`.
- Low mail uses `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`.
- Incoming mail uses a custom message type so it is both visible and included in model context.

No priority cancels an active tool. High means earliest safe Pi steering point, not mid-tool preemption.

### Settlement and response enforcement

On `agent_settled`:

1. Update status and usage.
2. Query the broker for unanswered requests delivered to that worker.
3. If unanswered requests exist, immediately prompt with the first enforcement message.
4. If the enforcement run settles with obligations remaining, use the final enforcement message.
5. Reset the enforcement count when all obligations are answered.
6. After the configured retry limit, mark the worker noncompliant/failed and send a high-priority broker notification to the main thread. Do not impersonate the worker or fabricate a result.
7. If there are no unanswered requests, dispatch queued low mail or mark the worker idle.

A bare acknowledgement should not be encouraged as a way to satisfy the obligation. The broker can verify a reply tool call, while the prompt is responsible for requiring substantive content.

### Shutdown and resume

On `session_shutdown`:

1. Stop accepting new broker operations.
2. Abort or pause active worker runs according to configuration.
3. Flush registry, mail, and event journals.
4. Dispose worker sessions and subscriptions.
5. Clear widgets and reject late callbacks through the generation token.

The default should pause workers rather than leave model requests running after the parent Pi process exits. Resume reconstructs workers from their session files and redelivers only mail without a durable delivery confirmation.

## Configuration

Use global and trusted project-local configuration:

```text
~/.pi/agent/subagents.json
<project>/.pi/subagents.json
```

Example:

```json
{
  "defaultEffort": "medium",
  "maxAgents": 8,
  "maxConcurrent": 4,
  "maxMessageBytes": 32768,
  "responseReminderLimit": 2,
  "roles": {
    "scout": {
      "effort": "low",
      "tools": ["read", "grep", "find", "ls"],
      "instructions": "Explore and report concise evidence. Do not modify files."
    },
    "reviewer": {
      "effort": "high",
      "tools": ["read", "grep", "find", "ls", "bash"],
      "instructions": "Review for correctness and return findings with paths."
    },
    "worker": {
      "effort": "medium",
      "tools": ["read", "grep", "find", "ls", "bash", "edit", "write"]
    }
  },
  "addresses": {
    "reviewer.audit-auth@gpt-5.4.com": {
      "effort": "high"
    }
  }
}
```

Merge behavior:

- Project configuration overrides global configuration only when the project is trusted.
- Exact address overrides role configuration.
- The model field is never taken from configuration when an address explicitly contains a model; the address remains authoritative.
- Unknown tools are reported and omitted rather than causing silent prompt/tool mismatch.
- Configuration is reloaded with a manual `/reload-runtime` on Pi 0.81.1; live workers retain immutable identity but paused/idle settings may be updated explicitly through the dashboard.

## Persistence

Store runtime data outside the repository by default:

```text
~/.pi/agent/subagents/<parent-session-id>/
├── registry.json
├── mail.jsonl
├── events.jsonl
└── sessions/
    ├── <address-hash>.jsonl
    └── ...
```

Requirements:

- Parent directory permissions should be `0700`; files containing mail/session content should be `0600` where supported.
- `mail.jsonl` and `events.jsonl` are append-only journals.
- `registry.json` is written through a temporary file and atomic rename.
- Full email bodies remain in persistence and tool details; UI previews are bounded.
- Recovery should be at-least-once with envelope-ID deduplication.
- A crash between context acceptance and delivery marking may cause a duplicate retry; the injected email ID lets the model and broker identify it.
- Parent `/tree` navigation does not rewind the fleet in v1. Workers are external side effects scoped to the parent session ID, and the dashboard should state this clearly.

## Concurrency and workspace safety

- Default limits: 8 registered agents and 4 actively running workers, both configurable.
- Use a semaphore for active workers and a per-address singleflight map for spawn.
- Agent sessions and mailboxes are serial per address but parallel across addresses.
- Read-only roles should be the default for scouting and review.
- Writable workers must be explicitly configured with `edit`/`write`.
- In-process workers benefit from Pi's process-wide file mutation queue, but this prevents only overlapping file writes—not semantic conflicts.
- The dashboard should warn when multiple writable workers share one working directory.
- Optional Git worktree isolation and merge assistance belong in a later version.

## Observability and UI

### Persistent status

Use a compact widget or footer status:

```text
Agents: 2 running · 1 queued · 1 idle · 3 unanswered
```

Keep it to one line by default. Hide it when no workers or mail exist unless the user pins it.

### Tool rendering

`send_email` collapsed rendering should show:

- Recipient
- Priority
- Subject preview
- Whether the recipient was spawned
- Selected model and effort
- Answered email ID, if any

`fetch_emails` collapsed rendering should show the unanswered count and compact sender/subject rows. Expanded rendering shows complete envelopes.

### Incoming mail rendering

Register a custom message renderer that shows:

```text
📬 reviewer.audit-auth@gpt-5.4.com → main@gpt-5.4.com [LOW]
Re: Audit refresh-token handling

<message preview>
```

Expanded mode includes envelope ID, timestamps, full body, and reply relationship.

### `/agents` dashboard

The dashboard should provide:

- Agent address, status, elapsed time, model, effort, current activity, unread/unanswered count, context usage, tokens, and cost.
- A bounded activity feed of assistant text and tool calls, excluding hidden thinking.
- Inbox view with unanswered mail first.
- Actions to compose email, inspect transcript, stop, restart, or change idle-agent effort.
- Clear indication when a worker is queued by concurrency limits or failed response enforcement.

Suggested keys:

- Up/down: select agent
- Enter: inspect
- `e`: compose email
- `i`: inbox
- `k`: stop/abort
- `r`: restart
- `m`: change effort while idle
- Escape: close

Prefer a stable full-screen custom component for v1. A floating overlay can be added after the interaction is reliable.

### Notifications

Use notifications sparingly:

- Worker failed or became noncompliant.
- High-priority mail arrived.
- Invalid model/address or spawn failed.
- Concurrency/budget limit prevented immediate start.

Ordinary progress should update the widget/dashboard without adding parent context.

## Commands and shortcut

- `/agents`: open the dashboard.
- `/agents <address>`: open one agent directly when practical.
- `/agents stop <address>`: stop from non-TUI/RPC-compatible command handling.
- `/agents restart <address>`: reopen a stopped/failed worker.
- `/agents effort <address> <level>`: change effort only while idle.
- A configurable shortcut such as `Ctrl+Shift+A`: open `/agents`.

The model should coordinate only through tools; slash commands are user-facing control and inspection surfaces.

## Security and trust

- The feature is virtual internal mail; it performs no SMTP or external email network operations.
- Sender identity comes from the tool closure, never model input.
- Validate local-part syntax, `.com` suffix, model ID, message size, and priority before persistence.
- Reject path traversal and never derive filesystem paths directly from unsanitized addresses; use hashes.
- Honor Pi project trust before reading project-local role/configuration files.
- Child sessions must not recursively discover and initialize `pi-email-subagent` as another top-level broker.
- Default child extension loading should be deny-by-default or explicitly allowlisted.
- Enforce spawn, concurrency, depth, mail-rate, and cost limits to constrain runaway agent trees or mail loops.
- Do not include credentials, provider auth, hidden thinking, or unrelated session data in email details or UI.
- Tool and UI output must be truncated using Pi's standard line/byte limits, with full data retained in persistence.

## Error handling

- Invalid address/model: reject before creating an envelope or worker.
- Missing model authentication: return an actionable spawn error and leave no half-created worker.
- Worker creation failure: mark envelope failed, preserve diagnostics, and notify sender.
- Provider failure: preserve worker session, expose status, and allow restart/retry.
- Tool abort: stop the enqueue/spawn operation if not committed; once mail is committed, report its durable state.
- Recipient crash after acceptance: keep mail queued for resume.
- Malformed reply subject: do not mark any request answered; explain the exact correction.
- Unknown reply ID or wrong sender/recipient relationship: reject as a reply to prevent closing another thread's obligation.
- Repeated response-enforcement failure: mark noncompliant and notify main without forging content.

## Package structure

```text
package.json
README.md
src/
├── index.ts
├── broker/
│   ├── agent-broker.ts
│   ├── address-router.ts
│   ├── scheduler.ts
│   └── types.ts
├── mail/
│   ├── mail-store.ts
│   ├── reply-parser.ts
│   └── formatter.ts
├── workers/
│   ├── worker-manager.ts
│   ├── worker-transport.ts
│   ├── sdk-worker.ts
│   └── resource-loader.ts
├── prompts/
│   ├── shared-mail.ts
│   ├── main-coordinator.ts
│   ├── subagent.ts
│   └── enforcement.ts
├── tools/
│   ├── send-email.ts
│   └── fetch-emails.ts
├── persistence/
│   ├── paths.ts
│   ├── registry.ts
│   └── journal.ts
├── ui/
│   ├── controller.ts
│   ├── dashboard.ts
│   ├── render-email.ts
│   ├── render-tools.ts
│   └── status-widget.ts
└── config/
    ├── load.ts
    └── schema.ts
test/
├── unit/
├── integration/
└── fixtures/
```

`package.json` should declare the package as a Pi package and expose `src/index.ts` as its extension entrypoint. Runtime dependencies belong in `dependencies`, not only `devDependencies`.

## Implementation phases

### Phase 1: Foundation

- Scaffold package, TypeScript configuration, lint/typecheck/test commands, and Pi manifest.
- Define schemas and core types.
- Implement address parsing/canonicalization against an injected model catalog.
- Implement reply-subject parsing and envelope formatting.
- Add unit tests before broker integration.

### Phase 2: Durable mail broker

- Implement mail and registry persistence.
- Implement sender-bound enqueue, reply tracking, and `fetchUnanswered`.
- Add per-address singleflight creation and bounded scheduler.
- Test crash/reload reconstruction and envelope deduplication.

### Phase 3: SDK workers

- Implement the `WorkerTransport` interface using `AgentSession`.
- Build controlled child resources and worker-bound tools.
- Resolve model and effort correctly.
- Subscribe to worker events and collect bounded activity/usage.
- Verify the parent extension is not recursively loaded in workers.

### Phase 4: Delivery and enforcement

- Route high and low mail to workers and main.
- Implement idle dispatch and batching.
- Add unanswered-mail checks on settlement.
- Add the two enforcement prompts and failure escalation.
- Test that normal replies do not generate infinite response obligations.

### Phase 5: Main Pi integration

- Register tools, prompts, custom messages, commands, lifecycle hooks, and renderers.
- Handle main model changes and preserve routing aliases.
- Guard against stale contexts during session replacement and reload.
- Account for nested worker usage in dashboard totals without incorrectly adding it to a single parent tool result.

### Phase 6: Observability

- Add status widget and incoming/outgoing renderers.
- Implement `/agents` dashboard and controls.
- Add notifications for high-priority mail and failures.
- Verify all component lines obey terminal width and theme invalidation rules.

### Phase 7: Hardening and packaging

- Add trust checks, limits, truncation, file permissions, and shutdown behavior.
- Add integration tests with fake models/transports.
- Dogfood parallel scouting, review, and worker scenarios.
- Document configuration, addresses, priority etiquette, recovery behavior, and limitations.

## Test strategy

### Unit tests

- Parse model IDs containing dots from addresses such as `gpt-5.4`.
- Reject missing name/task slug, malformed suffixes, and unregistered models.
- Canonicalize lowercase names and task slugs consistently.
- Parse valid, malformed, foreign, and duplicate reply IDs.
- Sort unanswered mail by high priority and FIFO arrival.
- Merge global/project config with trust correctly.
- Apply exact-address, role, and default effort precedence.

### Broker tests

- Two concurrent sends to one unknown address create one worker.
- Sends to different addresses start in parallel up to the configured limit.
- High mail overtakes queued low mail without cancelling active tools.
- Low mail waits for settlement.
- Reply acceptance atomically marks the referenced request answered.
- Replies do not create acknowledgement loops.
- Invalid replies cannot answer another sender's request.
- Durable queued mail resumes after simulated crash.
- Agent and mail limits return clear failures.

### Worker tests

- Worker receives the correct identity, model, effort, tools, and prompt.
- Worker tools bind sender identity and cannot spoof it.
- Child resources exclude recursive broker initialization.
- Settling with unanswered mail triggers enforcement.
- Successful enforcement clears the obligation and returns the worker to idle.
- Repeated noncompliance escalates to main.
- Abort and dispose clean up event listeners and active model work.

### Main-session tests

- Worker high mail uses steering delivery.
- Worker low mail uses follow-up delivery.
- Main model changes create a new canonical address while old aliases still route.
- Reload/session replacement rejects late callbacks from the old broker.
- Incoming custom messages participate in context and render correctly.

### UI tests

- Narrow terminal widths never produce overlong lines.
- Dashboard updates while workers run.
- Expanded and collapsed email/tool renderers preserve all important metadata.
- Theme invalidation rebuilds pre-colored content.
- Dashboard controls work when agents are queued, running, idle, failed, or stopped.

### Manual acceptance scenarios

1. Send two independent low-priority requests to different registered model addresses and observe concurrent work.
2. Continue main work while both agents run.
3. Open `/agents`, inspect current tools and partial output, then return without interrupting workers.
4. Receive one low-priority result only after main settles.
5. Receive a high-priority blocker at the next safe boundary and reply to it.
6. Send a second email to an existing address and confirm its context is reused.
7. Force a subagent to omit its reply and observe automatic enforcement.
8. Restart Pi and confirm sessions, addresses, unanswered mail, and paused workers restore.

## Acceptance criteria

The first release is complete when:

- `send_email` to an unknown valid address creates exactly one persistent worker and returns without waiting for completion.
- At least two workers can run concurrently while the main agent continues.
- Every worker and the main agent have functioning `send_email` and `fetch_emails` tools plus the documented prompts.
- Model resolution uses only Pi's registered catalog; effort resolution follows config/UI precedence.
- High and low mail behave according to safe steering and settled follow-up semantics.
- `fetch_emails()` accurately reports unanswered response-required requests.
- A worker that settles without replying is automatically prompted to respond and escalated after bounded failure.
- `/agents` shows live status, model, effort, activity, mailbox counts, usage, and failures.
- Mail, registry, and worker sessions survive reload/resume without duplicate workers.
- Main model changes do not break replies sent to an earlier main address.
- Project-local configuration is ignored until trusted.
- Shutdown leaves no active timers, subscriptions, or model requests owned by the old extension instance.

## Future enhancements

- RPC subprocess worker backend.
- Git worktree-per-writable-agent isolation and assisted merge flow.
- Attachments and structured artifacts.
- User-defined mailbox retention and archival.
- Per-agent token/cost budgets and automatic suspension.
- Thread browsing beyond unanswered requests.
- Search across agent transcripts and mail.
- Web or tmux observability adapters using the same broker event stream.

