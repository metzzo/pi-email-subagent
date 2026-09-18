# Mechanistic-subagents

Status: proposed design; not implemented or runtime-tested.

## Goal

Add Python-backed mechanistic-subagents to `pi-email-subagent`. They perform or
observe work according to their programming, without an LLM. Keep and adapt the
existing email naming, delivery, identity, inspection, and lifecycle machinery.

Run Sentinel is one possible mechanistic-subagent program, not a separate
coordinator or a core dependency. The same capability should support command
execution, CI monitoring, file processing, and other programmed work. Nothing in
the core should depend on pi-software-engineer stages or run directories.

## Agreed requirements

- An email to a mechanistic-subagent starts its associated Python program with
  task-specific input.
- Its limited Python API reports progress (message and optional percentage),
  success, or failure.
- Its programming may send new emails to main, LLM agents, or other mechanistic
  agents. No main-thread relay is required.
- Mechanistic agents are **send-only after invocation**. They cannot reply to
  email, read an inbox, wait for agent replies, or interpret follow-up messages.
- Success and failure are status reports, not email replies. Do not manufacture
  a correlated reply on the script's behalf.
- The existing broker remains responsible for communication and lifecycle. Do
  not introduce another mailbox system, scheduler, or LLM-based watcher.

## Proposed behavior

### Identity and registration

Keep the `<name>.<task-slug>@<domain>.com` address shape. A proposed reserved
namespace is:

```text
ci.release-check@mechanistic.com
```

The registered name selects a Python program; the task slug identifies its work
context. This namespace is a proposal, not a currently routable model ID.

Registration declares the script path, Python executable, and working directory.
Persist the identity's script binding rather than interpreting it as a provider
or model. Preserve existing model-backed identities and reject ambiguous address
bindings. Mechanistic identities have no model, thinking effort, or token usage.

For the first version, use explicitly registered, trusted scripts. Email chooses
a registered program and supplies data; it does not supply executable code or a
shell command. Whether main may create and register task-specific scripts is a
separate permission decision, not implicit permission from sending mail.

### Starting work

Use the existing `send_email` interface. The message body can contain JSON with
arguments defined and validated by the selected script. There is no requirement
for a Python program to understand natural-language instructions.

Mail to a mechanistic recipient must not create an unanswered-email obligation:

- Default `requires_response` to `false` for these recipients.
- Reject an explicit `requires_response: true` before accepting the email.
- Treat the initiating email as a work notification, not a request for a reply.
- Track execution through job state and inspection, separately from mail delivery.

A proposed minimal runtime starts one Python process per initiating email. New
work for the same identity queues and runs serially. A queued email is a new job,
not a follow-up delivered into a running script. The script receives its initial
input and broker acknowledgments, but has no general inbox API.

### Limited Python API

Proposed surface:

| Operation | Purpose |
| --- | --- |
| `progress(message, percent=None)` | Publish a progress message and optional percentage from 0 to 100. |
| `send_email(to, subject, message, priority="low")` | Send a new notification under the script's own agent identity. |
| `success(summary, artifacts=None)` | Report successful completion of the current job. |
| `failure(summary, artifacts=None)` | Report failure of the current job. |

The SDK exposes no `reply_to`, reply completion metadata, `fetch_emails`, or
`wait_for_replies`. Outbound email always has `requires_response: false`. Broker
validation must enforce this even if a script bypasses the Python helper. Reject
attempts to use legacy reply subjects as well as explicit reply fields.

A send acknowledgment tells the script whether the broker accepted its email; it
is not a reply from the recipient. Preserve accepted mail IDs and delivery
uncertainty so callers do not blindly resend accepted work.

For a small local implementation, use a Python helper and validated JSON messages
on a private subprocess channel. Stdout can carry protocol messages and stderr
can carry ordinary logs. Reuse broker operations behind the helper rather than
exposing broker files, credentials, or an unrestricted sender parameter.

### Progress and outcomes

Progress updates the agent UI without waking the model on every percentage
change. Scripts can explicitly send an email when their programming identifies
something worth communicating. Bound progress message size and update frequency.

Success and failure update the job's recorded outcome and notify the parent Pi
main thread with a new, non-response-required status notification containing the
job identity, summary, and artifact references. This notification has no
`reply_to` and does not answer or close an email obligation. Do not automatically
send outcomes back to a mechanistic initiator: it cannot consume replies, and a
new email to it would start another job. Choose one notification path so a runtime
failure is not announced twice by the job wrapper and broker.

Record a task-reported failure separately from a Python crash, timeout, or forced
stop. Missing terminal output is not success. Process cleanup must settle before
the runtime claims the worker has stopped. Do not automatically rerun jobs after
a crash or restore: scripts may already have performed external side effects.

### Sending to other agents

The script chooses when and whom to email according to its programming. Support
main, existing LLM agents, and other registered mechanistic agents through the
same broker. Creation or reactivation of a recipient remains subject to broker
registration, capacity, and lifecycle checks.

This is notification-based collaboration, not a nested request/reply workflow.
For example:

```text
Main sends a CI-watching agent structured job arguments
  -> Python monitors CI and reports progress
  -> CI fails
  -> Python sends an LLM agent the failure evidence and asks it to notify main
  -> Python reports its own job outcome
  -> The LLM agent independently sends its diagnosis to main
```

The mechanistic agent neither waits for nor replies to the diagnosis. Its job
outcome does not claim that the LLM's separate work has finished.

## Ownership and limits

- **Python program:** work-specific logic and decisions about outgoing mail.
- **Python helper:** a small validated reporting and send-only interface.
- **Existing broker:** authenticated identity, mail acceptance and delivery,
  persistence, capacity, inspection, and lifecycle controls.
- **Pi UI:** progress and job state; actionable mail uses normal broker delivery.

A limited communication API does not sandbox Python or prevent filesystem,
network, or subprocess access. Trusted script registration is the initial trust
boundary; do not claim OS isolation without implementing and testing it.

Keep the runtime owned by the parent Pi session, not a separate daemon. Persist
job and mail evidence, report interrupted work on restore, and require an
explicit decision before rerunning it. Stopping a script does not imply that a
remote job it was observing has also stopped. Preserve evidence when local
process cleanup cannot be confirmed.

No PSE-specific parsing belongs in the runtime. A future PSE-specific script must
respect that project's display-only progress contract rather than forwarding its
raw progress or thinking into email.

## Existing implementation seams

These are current constraints to adapt, not claims that script support exists:

- [`src/address.ts`](../src/address.ts) resolves recipient domains through the
  model catalog. Add an explicit script-backed address route.
- [`src/types.ts`](../src/types.ts) defines `AgentRecord`, `WorkerTransport`, and
  startup configuration with model-specific fields. Separate the necessary
  script/model differences without building a general plugin framework.
- [`src/index.ts`](../src/index.ts) creates model runtimes and SDK workers. Add
  selection of the Python-backed runtime while preserving the LLM path.
- [`src/broker.ts`](../src/broker.ts) currently blocks new worker-to-worker mail.
  Explicitly permit mechanistic senders to send new notifications. Also enforce
  send-only behavior and non-response-required mail to mechanistic recipients.
- Reuse [`src/mail-store.ts`](../src/mail-store.ts), existing delivery rules, and
  [`src/ui.ts`](../src/ui.ts); do not create parallel mail storage or routing.

## Implementation plan

1. **Define the contract and identity changes.**
   Finalize registration and the reserved namespace. Add typed script identities,
   input validation, send-only mail rules, and compatibility tests for existing
   LLM records. Keep existing LLM-to-LLM delegation policy unchanged.
2. **Implement the Python runtime and helper.**
   Launch real registered scripts, deliver initiating input, validate protocol
   messages, capture logs, and handle terminal outcomes and cleanup. Implement
   progress and outgoing notifications, with no reply or inbox methods.
3. **Integrate with broker lifecycle and UI.**
   Support inspection, queued jobs, stop/shutdown, persisted outcomes, and honest
   restore behavior. Apply existing capacity controls rather than unlimited
   subprocess spawning. Adapt monitoring to scripted work without model retries
   or LLM-specific completion enforcement.
4. **Prove generality and document usage.**
   Add a command-running example and an unrelated status-monitoring example.
   Document registration, input format, outgoing mail, outcomes, trust limits,
   and stopping behavior. Run Sentinel remains an example program.

## Validation plan

Use real Python subprocesses, temporary files, and the production broker. Do not
substitute fake workers for the behavior under test. Capture complete test output
to durable artifacts, and distinguish local integration evidence from live-model
validation.

- Existing model-backed addresses and persisted identities still work.
- Registered script lookup works; unknown scripts and invalid input are rejected.
- Progress messages and percentages render without repeated model wakeups.
- Success, task failure, crash, timeout, malformed output, and missing terminal
  output remain distinguishable.
- Mechanistic-to-main, mechanistic-to-LLM, and mechanistic-to-mechanistic
  notifications retain the real sender and broker-generated mail IDs.
- No send-only operation creates an unanswered-email obligation or synthesizes a
  reply. Reject explicit and legacy replies and response-required mail for
  mechanistic agents, without changing ordinary LLM request/reply behavior.
- Terminal reports go to main, not back to a mechanistic initiator as accidental
  new jobs.
- A send acknowledgment is not confused with recipient completion; accepted mail
  is not resent solely because presentation or delivery is uncertain.
- Serial jobs, capacity exhaustion, busy/idle main delivery, and duplicate failure
  reporting follow the documented behavior.
- Stop, session shutdown, and restore preserve evidence and do not silently rerun
  work or claim remote processes have stopped.
- Both general-purpose examples work without PSE-specific state or dependencies.
- Validate live LLM recipient behavior only in an explicitly authorized live test;
  local protocol tests alone do not establish that a model follows the message.

## Decisions still open

- Final reserved address namespace and exact script registration format.
- Whether main may explicitly create and register new scripts, rather than only
  invoking previously registered utilities.

Reply capability is not an open decision: mechanistic agents are send-only.

## Validation status

This document records the design only. No runtime, Python API, address route, or
broker behavior described as proposed has been implemented or runtime-tested.
