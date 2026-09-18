"""Observe local status.txt in the trusted registration cwd.

Input: {"expected":"ready", "attempts":1..20, "notify_to":optional-address}.
Only disposable local input is needed. Trusted Python is not a sandbox.
"""
import time
from pathlib import Path
from pi_mechanistic import InvalidArguments, progress, run, send_email, success, failure


def main(args):
    expected = args.get("expected", "ready")
    attempts = args.get("attempts", 1)
    if set(args) - {"expected", "attempts", "notify_to"} or not isinstance(expected, str) or len(expected.encode("utf-8")) > 1024:
        raise InvalidArguments("Only expected (up to 1024 bytes), attempts, and notify_to are supported")
    if type(attempts) is not int or not 1 <= attempts <= 20:
        raise InvalidArguments("attempts must be an integer from 1 to 20")
    if "notify_to" in args and not isinstance(args["notify_to"], str):
        raise InvalidArguments("notify_to must be an address string")
    path = Path("status.txt")
    observed = None
    for attempt in range(attempts):
        progress("Inspecting local status.txt", (attempt + 1) * 100 / attempts)
        try:
            with path.open("rb") as source:
                content = source.read(4097)
            if len(content) > 4096:
                raise InvalidArguments("status.txt exceeds the 4096-byte example limit")
            observed = content.decode("utf-8").strip()
        except FileNotFoundError:
            observed = None
        if observed == expected:
            if args.get("notify_to"):
                ack = send_email(args["notify_to"], "Local status observed", "status.txt matched the expected value")
                if not ack.get("accepted"):
                    failure("Status matched but notification was not accepted", [str(path.resolve())])
                    return
            success("status.txt matched expected value", [str(path.resolve())])
            return
        if attempt + 1 < attempts:
            time.sleep(0.05)
    failure("status.txt did not match within the bounded observation window")


run(main)
