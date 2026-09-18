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
are resolved through PATH during registration. The broker checks file and
executable availability without executing registration probes.

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
Artifacts are unverified references, not uploaded or attested files.

## Inspect, stop and recover

`inspect_agent` and `/agents` show program binding, lifecycle, queue, recent job
IDs, progress, script report, runtime result, bounded stderr, exit and direct-child
cleanup evidence, and the linked main outcome. There is no conversation view or
model/effort control for Python identities. Every finalized job produces a new,
non-correlated notification to main; it cannot close an LLM request or satisfy
`wait_for_replies`.

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
