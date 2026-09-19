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

## Invoke

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
it is not recipient completion and the helper never resends. Use stderr for
ordinary logs: stdout belongs to the versioned, bounded JSONL protocol.
`success(summary, artifacts)` and `failure(summary, artifacts)` are terminal
reports. No command is legal afterward. Summaries/progress are limited to
4096 UTF-8 bytes; at most 32 artifact references, each 2048 bytes, are accepted.
Artifacts are unverified references, not uploaded or attested files. The complete
terminal frame must also fit 64 KiB, so the individual maxima cannot always be
combined in one report.

## Outcome size and main queue capacity

Automatic outcomes use the same subject/body and escaped, formatted byte/line
limits as ordinary main notifications. Small outcomes are unchanged. If needed,
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
runs only not-yet-started queued jobs, never a previous accepted ID. Archive
requires no active work, pending mail or cleanup quarantine.

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

The runner starts a fresh Pi RPC process, asks a real LLM to delegate through an LLM worker to the trusted `evidence` Python program, and retains bounded JSON evidence under `.test-workspaces/mechanistic-subagents/`. It asserts notification kinds, broker IDs, authenticated senders, no response obligations, and that the final notification contains the nonce read from the disposable evidence file. A failed run retains its complete diagnostic log; no external or destructive action is performed.

## Validation limits

Automated tests use real Python processes and disposable files. They cover
admission and caller-kind rules, helper acknowledgments, protocol limits,
stop/shutdown races, and fresh Pi owner loss at acceptance, start, running,
script-effect, and terminal/outcome commit boundaries. The package smoke executes
the installed helper and example through a fresh Pi process. LLM routing/result
loop tests use a local deterministic provider: they prove routing, not live-model
behavior.

These tests do not simulate power loss, interrupt an individual kernel write or
fsync, or prove detached/remote effects have settled. A stable journaled outcome
ID does not make Pi message presentation transactionally exactly once; the
presentation-before-delivery-mark crash window remains a host integration limit.
