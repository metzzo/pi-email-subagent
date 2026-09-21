"""Read-only GitHub Actions observation for a trusted registered checkout.

Input: {} or {"repository":"owner/repo", "commit":"commit-or-ref"}.
Requires git and gh authenticated to github.com on the trusted PATH. Inputs are data, never
commands. This program sends no email and never reruns or changes GitHub work.
"""
import json
import os
import re
import selectors
import signal
import subprocess
import time
from urllib.parse import quote
from pi_mechanistic import InvalidArguments, failure, progress, run, success


class ObservationError(Exception):
    pass


def read_command(argv):
    """Bound the actual child, captured output, and time; never use a shell."""
    env = dict(os.environ, GH_HOST="github.com")
    env.pop("GH_REPO", None)  # Default repository must come from the registered cwd.
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    output = bytearray()
    size = 0
    try:
        with selectors.DefaultSelector() as streams:
            streams.register(child.stdout, selectors.EVENT_READ)
            streams.register(child.stderr, selectors.EVENT_READ)
            deadline = time.monotonic() + 20
            while streams.get_map():
                if time.monotonic() >= deadline:
                    raise ObservationError(argv[0] + " read timed out; observation incomplete")
                for key, _ in streams.select(.1):
                    data = key.fileobj.read1(8192)
                    if not data:
                        streams.unregister(key.fileobj)
                        continue
                    size += len(data)
                    if size > 1024 * 1024:
                        raise ObservationError(argv[0] + " output exceeded 1 MiB; observation incomplete")
                    if key.fileobj is child.stdout:
                        output.extend(data)
            code = child.wait(timeout=max(.01, deadline - time.monotonic()))
            if code:
                # Do not forward gh stderr: it may contain credentials or private URLs.
                raise ObservationError(argv[0] + " read failed (exit " + str(code) + "); check checkout, gh authentication and repository access")
            return output.decode("utf-8").strip()
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=2)
        child.stdout.close()
        child.stderr.close()


def main(args):
    if set(args) - {"repository", "commit"}:
        raise InvalidArguments("Supported fields: repository (owner/repo), commit (commit or ref); {} uses the registered checkout")
    repository = args.get("repository")
    commit = args.get("commit")
    if repository is not None and (not isinstance(repository, str) or len(repository) > 200 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository) or ".." in repository):
        raise InvalidArguments("repository must be owner/repo")
    if commit is not None and (not isinstance(commit, str) or len(commit) > 200 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", commit) or ".." in commit):
        raise InvalidArguments("commit must be a bounded commit ID or ref, not an option or expression")
    try:
        progress("Resolving repository and exact commit", 0)
        repository = repository or read_command(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository) or len(repository) > 200 or ".." in repository:
            raise ObservationError("gh returned an invalid repository")
        if commit is None:
            commit = read_command(["git", "--no-optional-locks", "rev-parse", "--verify", "HEAD^{commit}"])
        else:
            commit = read_command(["gh", "api", "--method", "GET", "repos/" + repository + "/commits/" + quote(commit, safe=""), "--jq", ".sha"])
        if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", commit):
            raise ObservationError("Could not resolve an exact commit ID")
        commit = commit.lower()
        progress("Reading GitHub Actions for " + repository + " at " + commit, 50)
        raw = read_command(["gh", "api", "--method", "GET", "repos/" + repository + "/actions/runs?head_sha=" + commit + "&per_page=100", "--jq", "{total_count, workflow_runs: [.workflow_runs[] | {id,head_sha,status,conclusion}]}"])
        data = json.loads(raw)
        runs = data["workflow_runs"]
        total = data["total_count"]
        if not isinstance(runs, list) or len(runs) > 100 or type(total) is not int or total < len(runs):
            raise ObservationError("GitHub returned an invalid run list")
        counts = {"failed": 0, "pending": 0, "passed": 0, "other": 0}
        links_by_category = {category: [] for category in counts}
        for item in runs:
            if item.get("head_sha", "").lower() != commit or type(item.get("id")) is not int or item["id"] < 1:
                raise ObservationError("GitHub run does not match the exact checked commit")
            status, conclusion = item.get("status"), item.get("conclusion")
            category = "pending" if status in ("queued", "in_progress", "waiting", "requested", "pending") else "passed" if status == "completed" and conclusion == "success" else "failed" if status == "completed" and conclusion in ("failure", "timed_out", "action_required", "startup_failure") else "other"
            counts[category] += 1
            if len(links_by_category[category]) < 8:
                links_by_category[category].append("https://github.com/" + repository + "/actions/runs/" + str(item["id"]))
        links = [link for category in counts for link in links_by_category[category]][:8]
        summary = "GitHub Actions observed: " + (", ".join(str(counts[key]) + " " + key for key in ("failed", "pending", "passed", "other") if counts[key]) or "no runs found")
        summary += "\n" + repository + " at " + commit
        summary += "\n" + (links[0] if links else "https://github.com/" + repository + "/commit/" + commit + "/checks")
        if total > len(runs):
            summary += "\nPartial observation: showing " + str(len(runs)) + " of " + str(total) + " runs."
        summary += "\nObservation completed; this is not a claim that CI passed."
        success(summary, links)
    except (ObservationError, OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired) as error:
        detail = str(error) if isinstance(error, ObservationError) else "Required command or GitHub response unavailable/invalid"
        failure("GitHub Actions observation failed: " + detail)


def interrupted(_signal, _frame):
    # Unwind read_command's finally so stopping Python also kills its current gh/git child.
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    run(main)
