"""The test a Poetry sandbox fixture runs (sandbox-poetry.test.ts), as
hostile repository code would: it prints a marker, then reads everything it
can reach (its environment, the host files and folders named in
probe.json, every process's environment under /proc, the sandbox's home,
/tmp and cache, and the host Python's own site-packages) and fails if any
canary turns up, if the host's packages are visible, if it sees more than
its own few processes, or if it reaches the fake index over the network."""

import json
import os
import pathlib
import socket
import sysconfig
import sys

PROBE = json.loads((pathlib.Path(__file__).parent / "probe.json").read_text())
MAX_BYTES = 65_536
MAX_PROCESSES = 10

print(PROBE["printed"])


def readable(path):
    try:
        return pathlib.Path(path).read_text(errors="replace")
    except OSError:
        return ""


def walk(folder):
    found = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [name for name in dirs if name != ".venv"]
        for name in files:
            path = os.path.join(root, name)
            try:
                if os.path.isfile(path) and os.path.getsize(path) < MAX_BYTES:
                    found.append(readable(path))
            except OSError:
                pass
    return found


def pids():
    return [name for name in os.listdir("/proc") if name.isdigit()]


def test_finds_no_credential():
    seen = "\n".join(
        [
            json.dumps(dict(os.environ)),
            *map(readable, PROBE["files"]),
            *[text for folder in PROBE["dirs"] for text in walk(folder)],
            *[readable(f"/proc/{pid}/environ") for pid in pids()],
            *[text for folder in ("/home", "/tmp", "/cache") for text in walk(folder)],
        ]
    )
    for canary in PROBE["canaries"]:
        assert canary not in seen, canary
    assert len(pids()) < MAX_PROCESSES, f"sees {len(pids())} processes"


def test_host_packages_are_hidden():
    base = {"base": sys.base_prefix, "platbase": sys.base_prefix}
    for name in ("purelib", "platlib"):
        folder = sysconfig.get_path(name, vars=base)
        assert not os.path.isdir(folder) or os.listdir(folder) == [], folder


def test_reaches_no_network():
    try:
        with socket.create_connection(("127.0.0.1", PROBE["port"]), timeout=2) as conn:
            conn.sendall(b"GET /probe HTTP/1.0\r\n\r\n")
        reached = True
    except OSError:
        reached = False
    assert not reached
