"""Send-only helper for trusted Python programs. This is not a sandbox.

stdout belongs to the bounded v1 protocol. Use stderr for ordinary logs.
An accepted (or uncertain) send is never retried by this helper.
"""
import json
import os
import sys
import threading

_MAX_LINE = 65536
_lock = threading.Condition()
_pending = {}
_next_id = 1
_terminal = False
_reader = None
_invocation = None
_error = None


class InvalidArguments(ValueError):
    pass


def invocation():
    global _invocation, _reader
    with _lock:
        if _invocation is None:
            line = sys.stdin.buffer.readline(_MAX_LINE + 1)
            if len(line) > _MAX_LINE or not line.endswith(b"\n"):
                raise RuntimeError("Invalid invocation frame")
            value = json.loads(line.decode("utf-8"))
            if value.get("v") != 1 or value.get("type") != "invoke":
                raise RuntimeError("Unsupported invocation")
            _invocation = value
            _reader = threading.Thread(target=_read_acks, daemon=True)
            _reader.start()
        return _invocation


def arguments():
    """Decode only after broker acceptance; reject malformed/non-object JSON."""
    try:
        value = json.loads(invocation()["envelope"]["message"])
        if not isinstance(value, dict):
            raise InvalidArguments("Email body must be a JSON object")
        return value
    except (ValueError, KeyError) as error:
        raise InvalidArguments("Email body must be a JSON object") from error


def _read_acks():
    global _error
    try:
        while True:
            line = bytearray()
            while len(line) <= _MAX_LINE:
                byte = os.read(0, 1)
                if not byte:
                    break
                line.extend(byte)
                if byte == b"\n":
                    break
            if len(line) > _MAX_LINE or not line.endswith(b"\n"):
                raise RuntimeError("Broker acknowledgment lost; a send may have been accepted. Do not resend.")
            ack = json.loads(line.decode("utf-8"))
            with _lock:
                command_id = ack.get("id")
                if ack.get("v") != 1 or ack.get("type") != "ack" or command_id not in _pending:
                    raise RuntimeError("Invalid broker acknowledgment; do not resend")
                state = _pending[command_id]
                if state is None:
                    del _pending[command_id]
                else:
                    state.append(ack)
                _lock.notify_all()
    except Exception as error:
        with _lock:
            _error = error
            _lock.notify_all()


def _command(op, fields, wait=True):
    global _next_id, _terminal
    invocation()
    with _lock:
        if _terminal:
            raise RuntimeError("No commands are allowed after a terminal report")
        if _error:
            raise _error
        # Progress is best effort and nonblocking; caller can report the latest
        # value later. Broker persistence/publication is separately coalesced.
        if not wait and len(_pending) >= 16:
            return None
        while len(_pending) >= 16 and not _error:
            _lock.wait()
        if _error:
            raise _error
        command_id = _next_id
        line = (json.dumps(dict(v=1, id=command_id, op=op, **fields), ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
        if len(line) > _MAX_LINE:
            raise ValueError("Protocol frame exceeds 64 KiB")
        _next_id += 1
        state = [] if wait else None
        _pending[command_id] = state
        if op in ("success", "failure"):
            _terminal = True
        try:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
        except OSError as error:
            raise RuntimeError("Broker channel lost; send acceptance may be uncertain. Do not resend.") from error
        if not wait:
            return None
        while not state and not _error:
            _lock.wait()
        if not state:
            raise _error
        del _pending[command_id]
        _lock.notify_all()
        return state[0]


def progress(message, percent=None):
    if not isinstance(message, str) or not message.strip() or len(message.encode("utf-8")) > 4096:
        raise ValueError("Progress must contain 1–4096 UTF-8 bytes")
    if percent is not None and (isinstance(percent, bool) or not isinstance(percent, (int, float)) or not 0 <= percent <= 100):
        raise ValueError("Progress percent must be 0–100")
    return _command("progress", dict(message=message, **({} if percent is None else dict(percent=percent))), wait=False)


def send_email(to, subject, message, priority="low"):
    """Return acceptance evidence, not recipient completion. Never retries."""
    return _command("send_email", dict(to=to, subject=subject, message=message, priority=priority))


def _report(status, summary, artifacts, invalid=False):
    if not isinstance(summary, str) or not summary.strip() or len(summary.encode("utf-8")) > 4096:
        raise ValueError("Terminal summary must contain 1–4096 UTF-8 bytes")
    artifacts = [] if artifacts is None else artifacts
    if not isinstance(artifacts, list) or len(artifacts) > 32 or any(not isinstance(item, str) or not item.strip() or len(item.encode("utf-8")) > 2048 for item in artifacts):
        raise ValueError("At most 32 artifact references of 1–2048 bytes each")
    return _command(status, dict(summary=summary, artifacts=artifacts, **(dict(invalidArguments=True) if invalid else {})))


def success(summary, artifacts=None):
    return _report("success", summary, artifacts)


def failure(summary, artifacts=None):
    return _report("failure", summary, artifacts)


def run(main):
    """Classify argument errors without adding any communication capability."""
    try:
        main(arguments())
    except InvalidArguments as error:
        _report("failure", str(error), [], invalid=True)
