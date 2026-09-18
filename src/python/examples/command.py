"""Fixed operations only. Input: {"operation":"git-status", "notify_to":optional-address}.

Run in the trusted registration cwd. Email cannot specify executable text,
shell commands, program paths, Git arguments, or a working directory.
"""
import subprocess
import tempfile
from pathlib import Path
from pi_mechanistic import InvalidArguments, progress, run, send_email, success, failure


def main(args):
    if set(args) - {"operation", "notify_to"} or args.get("operation") != "git-status":
        raise InvalidArguments("Only operation=git-status and optional notify_to are supported")
    if "notify_to" in args and not isinstance(args["notify_to"], str):
        raise InvalidArguments("notify_to must be an address string")
    progress("Running fixed git-status operation", 0)
    # Never use shell=True or interpolate email input into argv.
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(["git", "--no-optional-locks", "status", "--short"], stdout=output, stderr=subprocess.STDOUT, timeout=20, check=False)
        output.seek(0)
        content = output.read(65536)
        truncated = bool(output.read(1))
    artifact = Path("command-status.txt")
    artifact.write_bytes(content + (b"\n[output truncated]\n" if truncated else b""))
    progress("Fixed command exited", 100)
    summary = "git-status exited " + str(result.returncode)
    if args.get("notify_to"):
        ack = send_email(args["notify_to"], "Fixed command evidence", summary + "; inspect command-status.txt")
        if not ack.get("accepted"):
            failure("Command finished but notification was not accepted", [str(artifact.resolve())])
            return
    (success if result.returncode == 0 else failure)(summary, [str(artifact.resolve())])


run(main)
