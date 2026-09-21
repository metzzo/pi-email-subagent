# Send-only Python programs

Mechanistic subagents run **trusted Python, not a sandbox**. Register a fixed
executable, script and working directory, then send a new notification to
`<program>.<task-slug>@mechanistic.com`. Each accepted mail ID creates one job
and may launch at most one direct child. No model is involved in that identity.

## Registration

Use global `<agent-dir>/subagents.json`, or `.pi/subagents.json` in an explicitly
trusted project. Untrusted project configuration cannot register programs.
For example, with an installed package under `/opt/pi-email-subagent`:

```json
{
  "mechanisticPrograms": {
    "command": {
      "python": "python3",
      "script": "/opt/pi-email-subagent/src/python/examples/command.py",
      "cwd": "/absolute/path/to/repository"
    },
    "monitor": {
      "python": "python3",
      "script": "/opt/pi-email-subagent/src/python/examples/status_file.py",
      "cwd": "/absolute/path/to/disposable-input",
      "allowedCallers": ["main", "llm"]
    }
  }
}
```

Use your actual installed package paths. Relative script/cwd paths resolve from
the global agent directory or trusted project root, respectively. Python names
are resolved through PATH during registration. The selected absolute invocation
path is retained without dereferencing the interpreter symlink, so a virtualenv's
`bin/python` keeps its `sys.prefix` and installed modules. The broker checks file
and executable availability without executing registration probes. Existing
identities still require exact matching bindings; older bindings to a resolved
system interpreter are never silently changed into virtualenv bindings.

Callers default to `["main"]`. Explicit caller kinds are `main`, `llm`, and
`mechanistic`. Opting an LLM into a named program does **not** permit LLM-to-LLM
nested delegation. Duplicate canonical keys across trusted layers fail rather
than shadowing another program. `mechanistic.com` is reserved, including main
and legacy/persisted model collisions. Existing identities keep their exact
bindings: restore the original configuration rather than silently rebinding.

## Direct commands and CI status

Register the shipped observer once using your actual package and checkout paths:

```json
{
  "mechanisticPrograms": {
    "ci": {
      "python": "python3",
      "script": "/opt/pi-email-subagent/src/python/examples/github_ci.py",
      "cwd": "/absolute/path/to/repository",
      "description": "Observe GitHub Actions for an exact commit; never change CI",
      "inputExamples": ["{}", "{\"commit\":\"main\"}"]
    }
  }
}
```

Discover and invoke without an LLM dispatcher:

```text
/agents programs
/agents program ci
/agents run ci.main-status {}
/agents run ci.release-check {"commit":"main"}
```

Descriptions are optional safe single-line text, at most 256 UTF-8 bytes. Input
examples are optional safe, single-line JSON-object **strings**, at most three of
1024 UTF-8 bytes each. Inspection displays the exact supplied text for copying:
number spelling, escapes and spaces are preserved; multiline examples are rejected.
Discovery does not spawn work or change binding authority. Examples are not repeated
in every model prompt.

The observer requires `git` and authenticated `gh` on the trusted PATH. `{}` uses
the repository and current commit in the registered cwd, not the caller's cwd.
Optional `repository` is `owner/repo`; optional `commit` is a commit ID or ref
resolved through GitHub. Every observation names the exact checked commit and
provides at most eight run links: failed first, then pending, passed and other,
preserving GitHub's order within each category. It reads at most 100 GitHub Actions
runs, flags partial results,
and distinguishes failed, pending, passed, other, and absent runs. **A successful
observation does not mean CI passed.** Other CI providers are not observed.
The program never reruns, dispatches, cancels or changes GitHub work, and sends
no explicit email. Each child command has a 20-second deadline and 1 MiB captured
output limit; the registered job lifecycle still applies.

Direct commands use the existing durable mail/job path. Acceptance shows one
job ID and actual state, not completion. The TUI returns after acceptance and
uses the existing progress/dashboard and outcome views. Headless commands wait
for that exact job's terminal record, outcome delivery and finalization authority
to settle. The finite command deadline is 60 seconds plus the job's spawn, run,
abort and dispose deadlines. A timeout or observation/delivery error retains the
accepted ID and no-resend guidance; it does not authorize replay.

```sh
pi -p '/agents run ci.main-status {}'
pi --mode json '/agents run ci.main-status {}'
```

Print mode writes command receipts and direct results to stdout. JSON and RPC
expose displayed custom messages with structured details; in RPC send the command
as a `prompt`. Do not wait for `agent_settled`: these commands and their automatic
outcomes do not start a model turn. This presentation choice is journaled and
survives busy-main delivery, stop and restoration. Agent-initiated `send_email`
keeps ordinary completion-notification behavior. A trusted program's explicit
mail to an LLM is still ordinary authorized mail; the CI observer never sends it.

Pi 0.85.1 does not persist a fresh native session file until an assistant message
exists. A zero-model direct command still journals its job under
`<agent-dir>/subagents/<session-id>/mail.jsonl`, but that alone does not create a
resumable native Pi session. Structured acceptance includes the session ID/path
and whether that file currently exists. Use an already-persisted Pi session when
ordinary session resume is needed; this extension does not synthesize assistant
messages or write native session files to work around the host limitation.

## Agent-initiated invocation

```json
{
  "to": "command.check-tree@mechanistic.com",
  "subject": "Inspect working tree",
  "message": "{\"operation\":\"git-status\"}",
  "priority": "low"
}
```

The fixed command example writes `command-status.txt` in its registered cwd.
It accepts only `git-status`, never arbitrary commands, shell text or argv.
The monitor example reads local `status.txt`; input is
`{"expected":"ready","attempts":3}` (at most 20 short observations). Both can
optionally send evidence to a `notify_to` address before reporting their result.

Omit `requires_response` (or use false). Do not use `reply_to`, legacy reply
subjects, completion data or effort. Mechanistic identities have no inbox,
fetch, wait, reply or completion-correlation API. High priority only changes
queued order; it never interrupts or steers a script. Identity lifecycle
overrides use the existing finite broker deadlines and are creation-only;
script-originated mail cannot set lifecycle. JSON-object and program-specific
argument validation happens **after** acceptance, in Python.

## Write a program

```python
from pi_mechanistic import run, progress, success, InvalidArguments

def main(args):
    if set(args) != {"operation"} or args["operation"] != "observe":
        raise InvalidArguments("Only operation=observe is supported")
    progress("Observing configured local input", 50)
    success("Observation finished", [])

run(main)
```

The broker adds the installed package's `src/python` directory to PYTHONPATH;
do not copy the helper from a checkout. `invocation()` exposes the original
envelope and accepted job ID. `send_email(to, subject, message, priority="low")`
returns structured acceptance evidence, including the accepted ID when known;
it is not recipient completion and the helper never resends. If an append and its
rollback both fail, the error/ack retains the generated mail ID and says acceptance
is uncertain. Do not resend: restart and inspect that exact ID. The poisoned store
rejects further appends until restart; recovery may find the complete accepted
record even when its final newline was missing. Use stderr for
ordinary logs: stdout belongs to the versioned, bounded JSONL protocol.
`success(summary, artifacts)` and `failure(summary, artifacts)` are terminal
reports. No command is legal afterward. Summaries/progress are limited to
4096 UTF-8 bytes; at most 32 artifact references, each 2048 bytes, are accepted.
Artifacts are unverified references, not uploaded or attested files. The complete
terminal frame must also fit 64 KiB, so the individual maxima cannot always be
combined in one report.

## Outcome size and main queue capacity

Automatic outcomes use the same subject/body and escaped, formatted byte/line
limits as ordinary main notifications. Outcomes lead with the script's observation
and artifact references, then runtime/report and direct-child cleanup evidence.
If needed,
the broker omits artifact references, then shortens the summary, with an omitted
count and job ID; very small limits receive a job-journal pointer instead. This
changes only the derived notification. The complete script report and artifacts
remain in the durable job entry in the namespace's `mail.jsonl`.

Before accepting an invocation, the broker reserves one message and a conservative
byte allowance in the existing main queue. That allowance is the minimum of
`maxQueuedBytes`, `maxMessageBytes + maxSubjectBytes`, and the context-safe mail
byte limit. Every nonterminal job, including stopped/queued work, holds that
reservation. Ordinary main notifications (including a script's own `send_email`)
count these reservations when checking queue capacity. If capacity is unavailable,
the invocation fails before acceptance; it does not execute Python.

Terminal persistence atomically replaces the existing reservation with one stable,
non-correlated outcome. It never waits for a second admission or a separate queue.
Reservations are derived from durable jobs after restore. Already-accepted work
still finalizes if queue limits were reduced; new admissions wait for space. Mail
limits too small for even the job pointer must be corrected before new work or
nonterminal-job restoration. An older queued notification that exceeds current
body/context limits fails delivery with its existing ID instead of being injected
or resent; its mail and full job evidence remain available.

## Inspect, stop and recover

`inspect_agent` and `/agents` show program binding, lifecycle, queue, recent job
IDs, progress, script report, runtime result, bounded stderr, exit and direct-child
cleanup evidence, and the linked main outcome. There is no conversation view or
model/effort control for Python identities. Every finalized job produces a new,
non-correlated notification to main; it cannot close an LLM request or satisfy
`wait_for_replies`. Inspection lists bounded, newest-first job summaries before
binding/log details, followed by short tails from the three most recent jobs with
stderr. A large old log cannot displace all recent summaries. Full reports and
logs remain in the structured inspection and durable journal; textual previews
are not the complete evidence.

A script's success report is not runtime success: a later crash, nonzero exit,
protocol error or deadline wins. Missing/duplicate terminal reports are not
success. Stop prevents pending work from starting and finitely terminates the
current direct child; it retains the identity lease and queued work. Restart
may run the same previously accepted ID only when its durable job was never
claimed; a claimed/interrupted ID is never replayed. Archive requires no active
work, pending mail or cleanup quarantine.

To explicitly abandon one **never-started queued** job, stop and settle the identity,
then use `cancel_request(request_id, reason)` with its exact accepted mail ID and a
substantive reason (8 characters minimum, 1024 UTF-8 bytes maximum). This also works
when the trusted program binding has been removed. The journal atomically marks
the trigger cancelled, records main's actor/reason, and terminalizes the job as
`abandoned` with one stable, uncorrelated outcome replacing its queue reservation.
No Python process is launched. Already-claimed or terminal jobs cannot be abandoned;
a concurrent start claim wins over cancellation. Ordinary LLM request cancellation
is unchanged. A script cannot report or forge the `abandoned` runtime result.

If a committed spawn/progress/finalization callback remains unsettled, stop returns
`LIFECYCLE_MECHANISTIC_SETTLEMENT_TIMEOUT` after the identity's abort-plus-dispose
deadline. The direct child is stopped independently, but its active claim, run slot,
and namespace ownership remain held until settlement or owner-death recovery.
Restart is rejected while settlement is outstanding; no synthetic terminal record
is written to hide the stall. Broker shutdown remains bounded and retains ownership
when these callbacks do not settle.

On restore, an accepted queued job reactivates an archived identity's exact binding
through normal identity capacity checks. Acceptance remains durable even if the
archived-to-queued registry save never completed. It is the same job ID, not a new
invocation; unavailable bindings still fail closed.

A durable start claim found after owner loss is interrupted and cleanup-unknown,
not replayed. Review files/process evidence before explicit `clear_failure`;
that operator action releases quarantine without rewriting historical cleanup
proof. Unknown cleanup blocks the exact identity, not unrelated identities.
SIGTERM/SIGKILL and pipe disposal are bounded, but the cleanup guarantee is only
for the direct child and observed pipes. Trusted scripts may launch descendants,
use credentials, access the network or change arbitrary files; detached effects
are not sandboxed or automatically proven settled. Design scripts accordingly.

## Opt-in live validation

The paid live chain is opt-in and uses disposable temporary files only:

```sh
LIVE_MODEL=openai-codex/gpt-5.6-luna npm run test:live:mechanistic
```

The runner starts a fresh Pi RPC process and asks a real main LLM to invoke the
trusted `evidence` Python program. Python sends structured evidence to a real LLM
worker, which sends the exact nonce/job result back to main. The runner retains
bounded JSON evidence under `.test-workspaces/mechanistic-subagents/`. It asserts
four notification-only envelopes, broker/job/outcome IDs, authenticated senders,
no response obligations, exact nonce linkage, delivered main-bound mail,
successful runtime/cleanup, stable main quiescence, protocol health, and observed
physical Pi close. A failed run retains only bounded structural diagnostics and
its isolated paths—never credentials, provider stderr, full messages, session
transcripts, or hidden reasoning. No external or destructive action is performed.

The read-only GitHub observer has a separate opt-in check:

```sh
LIVE_GITHUB_CI=1 npm run test:live:mechanistic-ci
```

It uses authenticated real `gh`, real `git`, the packaged observer, and GitHub's
network against the fixed evidence commit named by the harness. It never reruns,
dispatches, cancels, or changes CI. Each invocation writes one immutable bounded
artifact under `.test-workspaces/mechanistic-ux/` only after bounded cleanup is
final, then atomically updates `live-mechanistic-ci-latest.json` as a pointer to
that artifact. A completed observation is still not a claim that CI passed.
Read-only evidence for `metzzo/pi-email-subagent` commit
`17febc848812eedf91b79ed550050c1b4aba0dea` observed 1 failed, 0 pending,
6 passed, and 0 other runs. The retained historical macOS job log did not expose
its test failure, so that cause remains unverified.

## Validation limits

Automated tests use real Python processes and disposable files. They cover
admission and caller-kind rules, helper acknowledgments, protocol limits,
stop/shutdown races, and fresh Pi owner loss at acceptance, start, running,
script-effect, and terminal/outcome commit boundaries. The package smoke executes
the installed helper and example through a fresh Pi process. LLM routing/result
loop tests use a local deterministic provider: they prove routing, not live-model
behavior. CI observer fixture tests substitute only GitHub responses behind a
local HTTP Unix socket while using real git, gh, Python and broker behavior;
these are not evidence of an actual GitHub observation. Live GitHub verification
is separately opt-in and read-only.

These tests do not simulate power loss, interrupt an individual kernel write or
fsync, or prove detached/remote effects have settled. A stable journaled outcome
ID does not make Pi message presentation transactionally exactly once; the
presentation-before-delivery-mark crash window remains a host integration limit.
