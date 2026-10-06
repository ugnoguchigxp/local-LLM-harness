#!/usr/bin/env python3
"""Fixed docling deployment controller. No client command, image, path or env input."""
import json
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import time
import http.client
import fcntl
import socket
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path("/etc/larm-local-services/docling-desk")
STATE = Path("/var/lib/larm-local-services/observations/docling-desk.json")
PROJECT = "larm-docling"
RELEASE = "docling-knowledge-cpu-v1"


def run(args, timeout=180):
    result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout, env={
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home()),
        "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
        "DOCKER_HOST": f"unix:///run/user/{os.getuid()}/docker.sock",
    })
    return result.stdout


def compose(*args):
    return run(["/usr/bin/docker", "compose", "--project-name", PROJECT, "--env-file", str(ROOT / "images.env"), "--file", str(ROOT / "compose.yaml"), *args])


def manifest_digest():
    return hashlib.sha256((ROOT / "compose.yaml").read_bytes() + (ROOT / "images.env").read_bytes()).hexdigest()


def observe():
    ids = run(["/usr/bin/docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={PROJECT}"]).split()
    if any(not re.fullmatch(r"[a-f0-9]{12,64}", i) for i in ids):
        raise RuntimeError("invalid_container_identity")
    rows = json.loads(run(["/usr/bin/docker", "inspect", *ids])) if ids else []
    active, state, memory = [], "stopped", 0
    names = set()
    for row in rows:
        labels = row["Config"].get("Labels", {})
        if labels.get("io.larm.service") != "docling-desk" or labels.get("io.larm.release") != RELEASE:
            raise RuntimeError("unowned_container")
        name = labels.get("com.docker.compose.service")
        if name not in {"api", "processor"} or name in names:
            raise RuntimeError("duplicate_or_unknown_container")
        names.add(name)
        if row["State"].get("Running"):
            active.append(row["Id"])
        elif row["State"].get("OOMKilled") or row["State"].get("ExitCode", 0):
            state = "failed"
    if active:
        state = "running" if len(active) == 2 and len(rows) == 2 else "failed"
        for identity in active:
            connection = http.client.HTTPConnection("localhost", timeout=5)
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock.settimeout(5)
            connection.sock.connect(f"/run/user/{os.getuid()}/docker.sock")
            try:
                connection.request("GET", f"/containers/{identity}/stats?stream=false")
                response = connection.getresponse()
                if response.status != 200:
                    raise RuntimeError("memory_observation_unavailable")
                stats = json.loads(response.read(1024 * 1024))
                # Only anon is subtracted from pending peak; reclaimable file cache
                # already participates in MemAvailable and must not be counted twice.
                anon = stats.get("memory_stats", {}).get("stats", {}).get("anon")
                if not isinstance(anon, int) or isinstance(anon, bool) or anon < 0:
                    raise RuntimeError("memory_observation_unavailable")
                memory += anon
            finally:
                connection.close()
    value = {"serviceId": "docling-desk", "release": RELEASE, "manifestDigest": manifest_digest(), "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
             "state": state, "containerIds": sorted(active), "memoryUsageBytes": memory}
    STATE.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=STATE.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(value, f)
        os.chmod(temp, 0o644)
        os.replace(temp, STATE)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return value


def activity():
    token = (ROOT / "secrets/lifecycle-token").read_text().strip()
    req = urllib.request.Request("http://127.0.0.1:18766/internal/larm/activity", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=5) as r:
        raw = r.read(16385)
    if len(raw) > 16384:
        raise RuntimeError("activity_too_large")
    a = json.loads(raw)
    if a.get("contractVersion") != "larm.local-service-activity.v1" or not a.get("draining") or not a.get("drainToken"):
        raise RuntimeError("drain_required")
    if any(a.get(k) != 0 for k in ("queuedJobs", "runningJobs", "activeRequests", "processorActiveJobs")):
        raise RuntimeError("service_busy")


def perform(action):
    if action == "preflight":
        preflight()
    elif action == "start":
        previous = observe()
        if previous["containerIds"] or previous["state"] not in {"stopped", "failed"}:
            raise RuntimeError("group_quarantined")
        compose("up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180")
        observe()
    elif action == "stop":
        previous = observe()
        if not previous["containerIds"] and previous["state"] in {"stopped", "failed"}:
            return
        if previous["state"] != "running":
            raise RuntimeError("group_quarantined")
        activity()
        for service in ("api", "processor"):
            identities = compose("ps", "-q", service).split()
            if len(identities) != 1 or any(i not in previous["containerIds"] for i in identities):
                raise RuntimeError("group_identity_changed")
            run(["/usr/bin/docker", "kill", "--signal", "TERM", *identities], timeout=5)
            deadline = time.monotonic() + 60
            while True:
                rows = json.loads(run(["/usr/bin/docker", "inspect", *identities], timeout=5))
                if not any(row["State"].get("Running") for row in rows):
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("stop_timeout")
                time.sleep(0.25)
        observe()
    else:
        observe()


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"start", "stop", "observe", "preflight"}:
        raise RuntimeError("unsupported_operation")
    action = sys.argv[1]
    # Serialize observer and lifecycle control: a slow pre-stop observation must
    # never replace the stopped snapshot, or vice versa, with a newer timestamp.
    fd = os.open(STATE.parent / ".controller.lock", os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        deadline = None
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if action == "observe":
                    return
                if deadline is None:
                    deadline = time.monotonic() + 20
                if time.monotonic() >= deadline:
                    raise RuntimeError("controller_busy")
                time.sleep(0.05)
        perform(action)


def preflight():
    info = json.loads(run(["/usr/bin/docker", "info", "--format", "{{json .}}"]))
    if not any("rootless" in x for x in info.get("SecurityOptions", [])) or str(info.get("CgroupVersion")) != "2" or info.get("CgroupDriver") != "systemd":
        raise RuntimeError("rootless_cgroup_required")
    text = (ROOT / "images.env").read_text()
    for name in ("LARM_DOCLING_API_IMAGE", "LARM_DOCLING_PROCESSOR_IMAGE"):
        matches = re.findall(rf"^{name}=(\S+)$", text, re.M)
        if len(matches) != 1 or not re.fullmatch(r"(?:[A-Za-z0-9._/:@-]+@)?sha256:[a-f0-9]{64}", matches[0]):
            raise RuntimeError("pinned_image_required")
    if (ROOT / "manifest.sha256").read_text().strip() != manifest_digest():
        raise RuntimeError("deployment_digest_changed")
    compose("config", "--quiet")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No captured stderr/env/secret is printed. Observer failures leave prior state stale.
        print("local service operation failed", file=sys.stderr)
        sys.exit(1)
