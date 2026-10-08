#!/usr/bin/env python3
"""Real systemd user-cgroup tests. Does not certify the production UID/mount boundary."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


def run(args, check=True, timeout=10):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=timeout)


def pids(group):
    root = Path("/sys/fs/cgroup") / group.lstrip("/")
    result = set()
    if root.exists():
        for file in root.rglob("cgroup.procs"):
            try:
                result.update(int(p) for p in file.read_text().split())
            except FileNotFoundError:
                pass
    return result


def scenario(ignore_term):
    unit = f"larm-native-fixture-{uuid.uuid4().hex}.service"
    with tempfile.TemporaryDirectory(prefix="larm-cgroup-") as temp:
        root = Path(temp)
        worker = root / "worker.py"
        worker.write_text("""import json,os,signal,socket,subprocess,sys,time
if sys.argv[1]=='ignore': signal.signal(signal.SIGTERM,signal.SIG_IGN)
subprocess.Popen(['/usr/bin/python3','-c',"import subprocess,time; subprocess.Popen(['/bin/sleep','300']); time.sleep(300)"],start_new_session=True)
sock=socket.socket(); sock.bind(('127.0.0.1',0)); sock.listen()
open(sys.argv[2],'w').write(json.dumps({'pid':os.getpid(),'port':sock.getsockname()[1]}))
while True: time.sleep(1)
""")
        group = None
        try:
            run(["systemd-run", "--user", "--unit", unit, "--property=KillMode=control-group", "--property=SendSIGKILL=no",
                 "--property=TimeoutStopSec=2", "--property=MemoryMax=128M", "--property=MemorySwapMax=0", "--property=TasksMax=64", "--property=CPUQuota=50%",
                 "/usr/bin/python3", str(worker), "ignore" if ignore_term else "normal", str(root / "ready.json")])
            deadline = time.monotonic() + 10
            while not (root / "ready.json").exists():
                if time.monotonic() >= deadline:
                    raise RuntimeError("fixture_start_timeout")
                time.sleep(0.05)
            group = run(["systemctl", "--user", "show", unit, "--property=ControlGroup", "--value"]).stdout.strip()
            deadline = time.monotonic() + 5
            while len(pids(group)) < 3 and time.monotonic() < deadline:
                time.sleep(0.05)
            before = pids(group)
            if len(before) < 3:
                raise RuntimeError("child_fixture_incomplete")
            stopped = run(["systemctl", "--user", "stop", unit], check=False)
            remaining = pids(group)
            if ignore_term:
                if not remaining:
                    raise RuntimeError("term_timeout_was_not_preserved")
            elif remaining or stopped.returncode:
                raise RuntimeError("descendants_remain")
            return {"scenario": "TERM ignored" if ignore_term else "parent, child, grandchild, separate session", "beforePids": len(before), "afterPids": len(remaining), "systemctlStopExitCode": stopped.returncode, "passed": True}
        finally:
            # Explicit test-only cleanup after recording the normal no-KILL result.
            run(["systemctl", "--user", "kill", "--signal=KILL", unit], check=False)
            run(["systemctl", "--user", "stop", unit], check=False)
            run(["systemctl", "--user", "reset-failed", unit], check=False)
            if group:
                deadline = time.monotonic() + 5
                while pids(group) and time.monotonic() < deadline:
                    time.sleep(0.05)
                if pids(group):
                    raise RuntimeError("test_cleanup_unconfirmed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("evidence file already exists")
    result = {"scope": "user-systemd process cleanup; dedicated App UID and external storage untested", "cases": [scenario(False), scenario(True)]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
