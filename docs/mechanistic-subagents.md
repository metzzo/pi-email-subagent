# Mechanistic-subagents

Status: reviewed implementation design; production code and runtime validation are
not yet complete.

## Goal

Add Python-backed mechanistic-subagents to `pi-email-subagent`. A registered
program performs or observes work according to its code, without an LLM. Reuse
the current address, broker, mail journal, capacity, lifecycle, inspection, main
delivery, and UI paths.

Run Sentinel is only a possible program. The runtime must be general enough for
fixed command operations, status monitoring, and file processing. It must not
contain pi-software-engineer stages, run-directory rules, or display contracts.

## Product rules

- One accepted email to a mechanistic identity creates one durable job and at
  most one Python process. A later email is a different job.
- A program can report progress, success, or failure and can send new
  notifications to main, an LLM identity, or another mechanistic identity.
- Mechanistic identities are send-only after invocation. They have no inbox,
  reply, fetch, wait, steering, follow-up, effort, model, thinking, token, or
  conversation API.
- A script outcome is a new status notification to main. It is never a reply,
  never closes an email obligation, and is never automatically sent to a
  mechanistic initiator.
- The existing broker remains the only communication, admission, capacity, and
  lifecycle owner. Do not add a mailbox, scheduler, daemon, plugin framework, or
  LLM watcher.
- Trusted Python is not sandboxed. The narrow helper limits broker authority; it
  does not limit Python filesystem, network, subprocess, or remote effects.
- Never automatically replay a job whose process may have started. A person can
  inspect its evidence and explicitly send a new email with a new job ID.

## Fixed v1 identity and registration decisions

### Reserved namespace

`mechanistic.com` is reserved for mechanistic identities:

```text
command.release-check@mechanistic.com
```

The registration key is the address name (`command`); the task slug
(`release-check`) identifies the persistent work context. The reserved domain is
not a model ID.

Startup fails closed if a catalog or main model ID, persisted model identity, or
durable model-binding intent claims `mechanistic`. Canonical duplicate program
registrations also fail instead of relying on route or config-layer order. An
unknown program name is rejected before mail acceptance and creates no envelope,
identity, job, or process.

### Trusted config only

V1 adds one bounded `mechanisticPrograms` map to trusted `subagents.json`
configuration. There is no email, tool, prompt, or runtime API for creating or
changing registrations.

A registration contains:

```json
{
  "mechanisticPrograms": {
    "command": {
      "python": "/usr/bin/python3",
      "script": "./mechanistic/command.py",
      "cwd": ".",
      "allowedCallers": ["main", "llm", "mechanistic"]
    }
  }
}
```

`allowedCallers` defaults to `['main']` and contains only broker-authenticated
caller kinds. Mail content cannot widen it. This is invocation authorization,
not script-registration authority.

Global config is trusted. Project config participates only when Pi marks the
project trusted. Relative global paths resolve from `agentDir`; relative project
paths resolve from the project `cwd`. A bare Python executable is resolved to an
exact executable path during startup; other paths are resolved to absolute
paths. Registration parsing is bounded and validates the executable, script,
and working directory without executing the program.

Persist the resolved registration key, executable, script path, and working
directory directly. Do not use a digest or other hash. An existing identity is
never silently rebound when config changes. A removed or conflicting binding is
reported unavailable until the trusted configuration is restored.

## Identity and type model

Use explicit discriminated variants, not fake model values and not a general
backend abstraction:

- `kind: 'llm'` retains the current provider, model, effort, usage, session,
  worker transport, and prompt behavior.
- `kind: 'mechanistic'` contains its resolved script binding, caller policy,
  current/recent bounded job evidence, progress, and cleanup state. It has no
  provider, model, effort, token usage, Pi session, or inbox fields.

Migrate existing version-1 registry records only to the LLM variant. Carry the
resolved mechanistic binding as durable intent on the first accepted envelope
and job, just as current LLM mail carries model-binding intent. Inspection and
`/agents` render script/job facts conditionally and reject model/effort actions
for mechanistic identities.

Keep the existing LLM `WorkerTransport` unchanged. Add one narrow Python process
controller selected by the broker for the mechanistic variant.

## Admission and mail semantics

### Sender and recipient matrix

| Authenticated sender | Recipient | Allowed new mail |
| --- | --- | --- |
| main | mechanistic | notification if the program allows `main` |
| LLM | mechanistic | notification if the program allows `llm` |
| mechanistic | main | notification |
| mechanistic | LLM | notification |
| mechanistic | mechanistic | notification if the target allows `mechanistic` |
| LLM | LLM | unchanged; current nested-delegation rule remains |

For a mechanistic recipient, omitted `requires_response` becomes `false`.
Explicit `requires_response: true`, `reply_to`, completion metadata, and a
recognized legacy reply subject are rejected before acceptance. The same rules
are enforced by the broker even if a program bypasses the Python helper.
Mechanistic outbound mail is always a new `requires_response: false`
notification, with the authenticated mechanistic identity as sender. A script
cannot supply or spoof `from`.

LLM prompts and the send tool description list only configured mechanistic
programs that the current LLM caller may invoke and explain that invocation is a
notification, not a nested request. This is a small config-derived addition to
the existing prompt, not a new behavioral prompt layer. Allowing
LLM-to-mechanistic notifications must not relax LLM-to-LLM delegation rules.

High priority changes mechanistic queue order only. It never steers a running
script and never bypasses ordinary queue bounds. Every job starts with exactly
one raw envelope; mechanistic jobs are never batched.

### Acceptance boundary

Broker-checkable failures happen before the journal acceptance point: malformed
address/envelope, reserved-domain collision, unknown registration, unauthorized
caller, forbidden response/reply fields, size/rate/queue/capacity failure, and
side-effect-free binding preflight. These return the existing not-accepted
semantics and create no job.

The email body is opaque task input at admission. JSON parsing and all
program-specific argument validation happen only after acceptance. Malformed
JSON, missing fields, or semantic argument rejection therefore retain the
accepted mail/job ID and become a terminal task or `invalid_arguments` outcome;
they are never relabeled as an admission error. No program is executed merely
to prevalidate an unaccepted email.

A helper `send_email` result distinguishes broker acceptance from recipient
completion. Its acknowledgment includes the stable accepted mail ID and any
delivery uncertainty. The helper never retries mail after an accepted or
possibly accepted result.

## Durable job state and recovery

Use the initiating `EmailEnvelope.id` directly as the job ID. Extend the existing
mail journal and its transaction/compaction logic; do not create a second job
store or queue.

The minimum durable sequence is:

1. Atomically append the accepted envelope and `job.queued`, including the exact
   resolved binding.
2. After the existing global run slot is held, atomically transition the single
   selected job to `starting` and mark its trigger delivered before spawning.
3. Record `running` with the generation and available direct-child evidence
   after spawn. A crash in the persisted `starting` window is intentionally
   treated as possibly started.
4. After protocol, process exit, and cleanup settle, atomically record the
   terminal job evidence and link/create one stable, non-correlated status
   notification to main.

Only `queued` means the program definitely has not started and may be scheduled
after restore. `starting`, `running`, or `stopping` found after an owner loss
becomes `interrupted`; it is never automatically run again. When exact direct
process cleanup cannot be confirmed, record `cleanup-unknown`, quarantine that
identity, preserve its evidence, and do not start its later queued jobs until an
operator explicitly resolves the failure through existing lifecycle controls.
Unrelated identities keep running.

A job records separately:

- the script-reported terminal (`success` or `failure`), if any;
- the runtime result (`success`, `task_failure`, `invalid_arguments`,
  `spawn_failure`, `crash`, `timeout`, `forced_stop`, `protocol_failure`,
  `missing_terminal`, or `interrupted`);
- exit code or signal and bounded logs;
- cleanup confirmation or uncertainty; and
- the stable outcome-notification mail ID and delivery state.

The outcome notification says what the script reported and what the runtime
observed. Artifact strings are references supplied by trusted code, not proof
that a file or remote effect exists. One stable envelope prevents duplicate
logical reports; Pi main-message presentation remains at least once where the
host has no durable append acknowledgment.

Journal retention preserves every nonterminal job and retained trigger/status
relationship. Compaction writes complete job snapshots with the related mail.
Recent terminal job history is bounded consistently with existing mail
retention.

## Python process and protocol

### Helper API

Ship an importable Python helper inside the packed `src` artifact. Registered
programs receive one invocation and can use:

| Operation | Purpose |
| --- | --- |
| `progress(message, percent=None)` | Replace the latest progress; percentage is 0–100. |
| `send_email(to, subject, message, priority='low')` | Send a new notification and return its broker acknowledgment. |
| `success(summary, artifacts=None)` | Report the program's terminal success. |
| `failure(summary, artifacts=None)` | Report the program's terminal task failure. |

Argument decoding utilities may classify validation errors as
`invalid_arguments`, but they do not create a new communication capability. The
helper exposes no reply field, completion metadata, inbox, fetch, wait, caller
identity override, or arbitrary broker operation.

### Private channel

Use versioned UTF-8 JSON Lines: stdin carries the initial invocation and bounded
broker acknowledgments; stdout is protocol-only; stderr is ordinary logs. Each
script command has a small monotonic command ID and receives exactly one
acknowledgment or error. A send acknowledgment includes the accepted mail ID and
delivery uncertainty. This is a fixed protocol, not a general RPC framework.

V1 uses fixed implementation limits rather than adding configuration knobs:

- 64 KiB maximum protocol line and unread stdout buffer;
- 64 KiB retained stderr tail while the pipe is continuously drained;
- 4 KiB progress and terminal-summary strings;
- at most 32 artifact references of at most 2 KiB each;
- at most 16 outstanding commands and a bounded acknowledgment write queue;
- the existing broker subject/message/rate/queue limits for outbound mail; and
- progress persistence/UI publication coalesced to at most four updates per
  second while retaining the latest value and terminal state.

Oversized, unterminated, invalid, unknown, duplicate, or post-terminal protocol
frames produce one `protocol_failure`. A progress flood cannot create mail or Pi
model turns. Stderr flooding cannot grow retained memory without bound.

Exactly one terminal frame is allowed. It is a report, not final proof. Finalize
success only after stdout and the direct child close cleanly with exit code zero.
A clean exit without a terminal is `missing_terminal`. A nonzero exit or signal
is `crash` even if success was reported, while preserving the contradictory
report. Protocol failure, timeout, or an already-requested forced stop takes
precedence and is recorded with any reported terminal.

### Timeouts and cleanup

Use the identity's existing finite lifecycle values and shared run capacity. On
stop, timeout, or shutdown, signal the exact direct child, wait
`abortTimeoutMs`, force-kill if needed, then wait up to `disposeTimeoutMs` for
that child and its protocol pipes. Release the run slot only after terminal
persistence and confirmed cleanup, or after persisting cleanup uncertainty and
quarantine.

Do not claim that this proves detached descendants or remote jobs stopped. V1
owns the direct child only and records that boundary honestly; it does not add an
OS process manager.

## Capacity, inspection, and UI

- A mechanistic identity consumes one existing `maxAgents` identity lease.
- A running process consumes one existing `maxConcurrent` run slot.
- Jobs for one identity are serialized. Different identities share the existing
  global scheduler and capacity checks.
- The current mail queue is the only pending-job queue. High comes before low,
  FIFO within a priority.
- Show current job ID, phase, latest progress, runtime result, cleanup evidence,
  bounded log tail, and recent jobs through existing snapshots, inspection, and
  `/agents` UI.
- Progress updates state/UI only. Script-selected mail and the one job outcome
  use normal broker delivery.
- Stopping leaves later queued jobs durable but inactive. An explicit restart
  may run jobs that were never claimed; it never reruns an interrupted job.

## Examples, packaging, and documentation

Ship the helper and two small general examples beneath a path included by
`npm pack`:

1. A fixed-operation command example. Email may select only documented,
   hard-coded operations such as `git-status`; it cannot provide executable
   text, a shell command, or a program path.
2. An unrelated local status/file-monitor example using disposable input.

The runtime must not branch on example purpose. The examples demonstrate
structured arguments, progress, notification sending, outcomes, and trust
limits without PSE dependencies.

Resolve bundled helper assets from `import.meta.url`, not the caller's current
working directory. Update the package inventory limits from measured pack
output, require the helper/example paths, and extend isolated installed-tarball
smoke coverage to execute a real registered Python job. Do not exclude required
files merely to satisfy the existing package cap.

Document config resolution, caller policy, address/input format, outcome and
acknowledgment semantics, lifecycle behavior, lack of sandboxing, and safe
stopping. Live tests remain opt-in.

## Implementation plan

1. **Contract, config, and types.** Add the fixed namespace and trusted bounded
   registration map; collision checks; caller matrix; discriminated address,
   identity, inspection, and registry variants; explicit v1 registry migration;
   and pre-accept send-only validation. Preserve all current LLM behavior.
2. **Durable jobs and process controller.** Extend the mail journal with the
   job states and atomic transitions above. Add the narrow real-Python
   controller and helper, bounded protocol, terminal precedence, direct-child
   cleanup, serialization, and no-replay recovery.
3. **Broker, lifecycle, and UI integration.** Select the mechanistic path once,
   reuse current capacity and main delivery, permit only the sender/recipient
   notification exceptions in the matrix, update inspection/UI, and keep
   progress outside model turns.
4. **Examples, docs, and deterministic validation.** Ship both safe examples,
   test with real Python processes and disposable files, update package policy
   from real artifact evidence, and preserve all existing LLM tests and coverage
   thresholds.
5. **Reusable E2E and live evidence.** Add a repeatable deterministic E2E command
   plus an opt-in real-model command using fresh Pi processes. Retain complete
   logs and report untested cases without treating a mock provider as live
   evidence.

## Validation plan

### Deterministic production-path validation

Use the production broker/runtime, real Python subprocesses, temporary
workspaces/files, finite deadlines, and settled cleanup. Do not fake the Python
behavior under test.

- Existing LLM addresses, prompts, request/reply obligations, high-priority
  steering, registry migration, and provider binding remain unchanged.
- Trusted global/project registration, untrusted-project exclusion, path bases,
  canonical duplicates, model/main/persisted collisions, removed bindings, and
  unknown programs fail as documented.
- Main/LLM/mechanistic caller policy and every sender/recipient row work; sender
  spoofing, response-required mail, explicit replies, legacy replies, and
  completion metadata are rejected with no journal/process effect.
- Accepted malformed JSON and script-specific invalid arguments keep their mail
  ID and finish as one post-acceptance job failure.
- One email creates one process; same-identity low/high jobs serialize; global
  capacity prevents overlap; high never steers; queue and stop/start races do
  not start two generations.
- Progress is nonblocking, coalesced, bounded, visible in inspection/UI, and
  creates no mail, Pi message, or model turn.
- Success, task failure, invalid arguments, spawn failure, crash, timeout,
  forced stop, protocol failure, missing terminal, interruption, and cleanup
  uncertainty remain distinguishable.
- Exercise partial/oversized/unterminated/invalid frames, unknown and duplicate
  command IDs, duplicate/post-terminal reports, success plus nonzero exit,
  stderr/progress floods, backpressure, excess artifacts, and accepted-send
  acknowledgment loss without resend.
- Mechanistic-to-main, mechanistic-to-LLM, and mechanistic-to-mechanistic mail
  retains the authenticated sender and broker-generated ID. Acceptance is not
  recipient completion. Outcomes never loop into a mechanistic initiator.
- Fault tests cover acceptance, durable start claim, spawn, external marker
  write, outbound send acceptance, terminal persistence, status-mail creation,
  stop, broker shutdown, and owner-death restore. Possibly started jobs never
  rerun; outcome mail has one stable ID; later work does not overlap cleanup
  uncertainty.
- Normal exit, TERM handling, TERM-ignore/forced kill, inherited pipe/detached
  descendant, shutdown deadline, and late cleanup settlement report only what
  the direct-child evidence proves.
- Both examples work without PSE state. The packed isolated install finds the
  helper via package location and runs a real registered Python job.

### Reusable E2E and live-model validation

Commit the runner, fixtures, assertions, documentation, npm commands, and full
logs. Deterministic E2E covers all broker/process cases above. Live calls are
opt-in and never perform external CI, deployment, or destructive actions.

At least one real Pi LLM agent must invoke an allowed mechanistic program and
independently process its evidence. The live chain must exercise:

```text
real LLM -> mechanistic notification
mechanistic -> real LLM notification
real LLM -> main notification
```

Assert durable mail/job IDs, sender identities, no response obligations or
result loop, and the LLM's evidence-based action—not only a final prose marker.
A scripted or mock provider proves deterministic routing only and must not be
reported as live-model validation.

## Validation status

The five-agent GPT-5.6 Sol xhigh initial review is recorded in
[`mechanistic-subagents-review.md`](mechanistic-subagents-review.md). It verified
current seams and required the decisions now incorporated above.

No production runtime, Python helper, examples, or reusable/live E2E described
here has yet been implemented or passed. Before implementation, the real
`npm run test:package` fails because the new documentation increased the packed
artifact above the old 51-entry cap; this is recorded evidence, not a waived
check. Implementation must update the measured package policy and return the
full validation suite to green without lowering unrelated coverage or weakening
assertions.
