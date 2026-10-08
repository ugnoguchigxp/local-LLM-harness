#!/usr/bin/env python3
"""Root-owned, fixed-unit process controller. No shell or consumer command execution."""
import fcntl
import hashlib
import json
import os
import re
import stat
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CONFIG_ROOT = Path("/etc/larm-local-services/process")
STATE_ROOT = Path("/var/lib/larm-local-services/observations")
REQUEST_ROOT = Path("/var/lib/larm/local-services/requests")
CGROUP_ROOT = Path("/sys/fs/cgroup")
UNIT_ROOT = Path("/etc/systemd/system")


def run(args, timeout=10):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout,
                          env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}).stdout


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def protected(path):
    # All parents must also prevent an application user replacing the trusted file.
    for item in [path, *path.parents]:
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("untrusted_deployment_file")


def load(service_id):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", service_id):
        raise RuntimeError("invalid_service")
    path = CONFIG_ROOT / f"{service_id}.json"
    protected(path)
    value = json.loads(path.read_text())
    if value.get("version") != 1 or value.get("serviceId") != service_id:
        raise RuntimeError("unsupported_manifest")
    payload = {k: v for k, v in value.items() if k != "manifestDigest"}
    if hashlib.sha256(canonical(payload)).hexdigest() != value.get("manifestDigest"):
        raise RuntimeError("manifest_changed")
    members = value["members"]
    if not members or len(members) > 16 or len({m["unit"] for m in members}) != len(members):
        raise RuntimeError("invalid_members")
    for name, digest in value["unitHashes"].items():
        if not re.fullmatch(r"larm-local-service-[a-z0-9-]+\.(service|target)", name):
            raise RuntimeError("invalid_unit")
        path = UNIT_ROOT / name
        protected(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError("unit_changed")
        props = properties(name)
        if props.get("FragmentPath") != str(path) or props.get("DropInPaths"):
            raise RuntimeError("unit_override_untrusted")
    return value


def properties(unit):
    names = ["LoadState", "ActiveState", "SubState", "InvocationID", "ControlGroup", "MainPID",
             "FragmentPath", "DropInPaths", "User", "KillMode", "SendSIGKILL", "Restart", "MemoryMax", "CPUQuotaPerSecUSec", "TasksMax",
             "NoNewPrivileges", "ProtectSystem", "ProtectHome", "PrivateTmp", "PrivateDevices", "DevicePolicy", "ProtectControlGroups", "Delegate"]
    text = run(["/usr/bin/systemctl", "show", unit, "--no-pager", "--property=" + ",".join(names)])
    result = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    if result.get("LoadState") != "loaded":
        raise RuntimeError("unit_not_loaded")
    return result


def storage(value):
    s = value["storage"]
    mount = Path(s["mountPoint"])
    root = Path(s["dataRoot"])
    if mount.resolve() != mount or root.resolve() != root or mount not in root.parents:
        raise RuntimeError("storage_path_changed")
    mounts = json.loads(run(["/usr/bin/findmnt", "--json", "--mountpoint", str(mount), "--output", "TARGET,UUID,OPTIONS"]))["filesystems"]
    if len(mounts) != 1 or mounts[0]["uuid"] != s["filesystemUuid"] or "rw" not in mounts[0]["options"].split(","):
        raise RuntimeError("required_storage_unavailable")
    fs = os.statvfs(root)
    if fs.f_bavail * fs.f_frsize < s["minFreeBytes"]:
        raise RuntimeError("storage_capacity_low")
    for p in value["writePaths"]:
        path = Path(p)
        if path.resolve() != path or root not in path.parents:
            raise RuntimeError("write_path_changed")


def preflight(value):
    storage(value)
    for name, version in value.get("nativePackages", {}).items():
        if run(["/usr/bin/dpkg-query", "-W", "-f=${Version}", name]) != version:
            raise RuntimeError("native_dependency_changed")
    for path, digest in value["assetHashes"].items():
        file = Path(path)
        protected(file)
        if hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise RuntimeError("asset_changed")
    for m in value["members"]:
        p = properties(m["unit"])
        checks = {"User": value["user"], "KillMode": "control-group", "SendSIGKILL": "no", "Restart": "no",
                  "NoNewPrivileges": "yes", "ProtectSystem": "strict", "ProtectHome": "yes", "ProtectControlGroups": "yes", "PrivateDevices": "yes", "DevicePolicy": "closed", "Delegate": "no"}
        if any(p.get(k) != v for k, v in checks.items()) or p.get("PrivateTmp") not in {"yes", "disconnected"}:
            raise RuntimeError("unit_protection_changed")
        if p.get("MemoryMax") != str(m["memoryMaxBytes"]) or p.get("TasksMax") != str(m["tasksMax"]):
            raise RuntimeError("resource_limit_changed")
        quota = re.fullmatch(r"([0-9.]+)(us|ms|s)", p.get("CPUQuotaPerSecUSec", ""))
        scales = {"us": 0.000001, "ms": 0.001, "s": 1}
        if not quota or float(quota[1]) * scales[quota[2]] != m["cpuQuotaPercent"] / 100:
            raise RuntimeError("cpu_limit_changed")


def group_processes(group):
    if group.is_symlink():
        raise RuntimeError("cgroup_path_untrusted")
    if not group.exists():
        return set()
    pids = set()
    for file in group.rglob("cgroup.procs"):
        try:
            pids.update(int(pid) for pid in file.read_text().split())
        except FileNotFoundError:
            pass
    return pids


def listeners(ports):
    # Any listener on an owned port prevents release, even when MainPID has gone.
    for name in ("tcp", "tcp6"):
        for line in Path(f"/proc/net/{name}").read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] == "0A" and int(fields[1].split(":")[1], 16) in ports:
                return True
    return False


def observe(value):
    rows, pids = [], set()
    memory = dict(anon=0, file=0, shmem=0, total=0)
    failed = False
    for m in value["members"]:
        p = properties(m["unit"])
        expected_group = f"/system.slice/{m['unit']}"
        if p.get("ControlGroup") and p["ControlGroup"] != expected_group:
            raise RuntimeError("cgroup_changed")
        group = CGROUP_ROOT / expected_group.lstrip("/")
        owned = group_processes(group)
        pids.update(owned)
        failed |= p["ActiveState"] == "failed"
        rows.append([m["unit"], p.get("InvocationID", ""), p["ActiveState"], bool(owned)])
        if group.exists():
            try:
                counts = dict(line.split() for line in (group / "memory.stat").read_text().splitlines())
                for k in ("anon", "file", "shmem"):
                    memory[k] += int(counts[k])
                memory["total"] += int((group / "memory.current").read_text())
            except FileNotFoundError:
                # Vanished group is safe only if the next full observation also confirms empty.
                raise RuntimeError("cgroup_observation_changed")
    active = any(row[2] not in {"inactive", "failed"} for row in rows)
    empty = not pids and not active and not listeners(set(value["ports"]))
    running = bool(pids) and all(row[1] and row[2] == "active" and row[3] for row in rows)
    token = None if empty else hashlib.sha256(canonical([
        Path("/proc/sys/kernel/random/boot_id").read_text().strip(), value["manifestDigest"], rows,
    ])).hexdigest()
    return {"serviceId": value["serviceId"], "release": value["release"], "manifestDigest": value["manifestDigest"],
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "state": "running" if running else ("failed" if failed or not empty else "stopped"),
            "instanceToken": token, "stopConfirmed": empty, "memoryUsageBytes": memory["anon"], "memory": memory}


def publish(value, observation):
    STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
    fd, temporary = tempfile.mkstemp(dir=STATE_ROOT)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(observation, f)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, STATE_ROOT / f"{value['serviceId']}.json")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def activity(value):
    token = Path(value["lifecycleSecret"]).read_text().strip()
    if not 32 <= len(token) <= 4096 or re.search(r"\s", token):
        raise RuntimeError("invalid_secret")
    request = urllib.request.Request(value["endpoint"] + "/internal/larm/activity", headers={"Authorization": "Bearer " + token})
    # Never forward a lifecycle credential to a redirect destination.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=5) as response:
        raw = response.read(16385)
    if len(raw) > 16384:
        raise RuntimeError("activity_too_large")
    a = json.loads(raw)
    observed = datetime.fromisoformat(a["observedAt"].replace("Z", "+00:00")).timestamp()
    if not 0 <= time.time() - observed <= value["staleAfterSeconds"]:
        raise RuntimeError("activity_stale")
    if a.get("contractVersion") != "larm.local-service-activity.v1" or any(type(a.get(k)) is not int or a[k] != 0 for k in ("queuedJobs", "runningJobs", "activeRequests", "processorActiveJobs")):
        raise RuntimeError("service_busy")
    return a


def stop(value):
    path = REQUEST_ROOT / f"{value['serviceId']}.json"
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 8192:
        raise RuntimeError("invalid_stop_request")
    request = json.loads(path.read_text())
    if set(request) != {"instanceToken", "appBootId", "drainToken", "manifestDigest", "requestedAt"}:
        raise RuntimeError("invalid_stop_request")
    age = time.time() - datetime.fromisoformat(request["requestedAt"].replace("Z", "+00:00")).timestamp()
    before = observe(value)
    if not 0 <= age <= 30 or request["manifestDigest"] != value["manifestDigest"] or before["state"] != "running" or request["instanceToken"] != before["instanceToken"]:
        raise RuntimeError("instance_changed")
    a = activity(value)
    if not a.get("draining") or not a.get("drainToken") or a["drainToken"] != request["drainToken"] or a["bootId"] != request["appBootId"]:
        raise RuntimeError("drain_ownership_changed")
    # Last identity check after the HTTP call, under the same control lock.
    if observe(value)["instanceToken"] != before["instanceToken"]:
        raise RuntimeError("instance_changed")
    work = []
    for member in value["members"]:
        if "workRoot" in member:
            invocation = properties(member["unit"])["InvocationID"]
            if not re.fullmatch(r"[a-f0-9]{32}", invocation):
                raise RuntimeError("invocation_changed")
            parent = Path(member["workRoot"])
            target = parent / invocation
            if parent.resolve() != parent or target.resolve() != target or Path(value["storage"]["dataRoot"]) not in parent.parents:
                raise RuntimeError("work_path_changed")
            work.append(target)
    run(["/usr/bin/systemctl", "stop", "--no-block", *[m["unit"] for m in value["members"]]])
    deadline = time.monotonic() + value["stopSeconds"] - 10
    while time.monotonic() < deadline:
        current = observe(value)
        if current["stopConfirmed"]:
            # Never delete another invocation's work, nor any persistent state.
            for path in work:
                if path.exists():
                    if path.resolve() != path:
                        raise RuntimeError("work_path_changed")
                    shutil.rmtree(path)
            publish(value, current)
            return
        time.sleep(0.25)
    raise RuntimeError("stop_unconfirmed")


def perform(value, action):
    if action == "preflight":
        preflight(value)
    elif action == "start":
        preflight(value)
        if not observe(value)["stopConfirmed"]:
            raise RuntimeError("start_requires_stopped_group")
        run(["/usr/bin/systemctl", "reset-failed", *[m["unit"] for m in value["members"]]])
        run(["/usr/bin/systemctl", "start", *[m["unit"] for m in value["members"]]], timeout=value["startSeconds"])
        publish(value, observe(value))
    elif action == "stop":
        stop(value)
    else:
        current = observe(value)
        if current["state"] == "running":
            try:
                storage(value)
            except Exception:
                current["state"] = "unknown"
                current["error"] = "required_storage_unavailable"
        publish(value, current)


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in {"start", "stop", "observe", "preflight"}:
        raise RuntimeError("unsupported_operation")
    STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
    service = sys.argv[1]
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", service):
        raise RuntimeError("invalid_service")
    fd = os.open(STATE_ROOT / f".{service}.lock", os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        deadline = time.monotonic() + 8
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("controller_busy")
                time.sleep(0.05)
        perform(load(service), sys.argv[2])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Only known symbolic reasons; never print captured output, URLs or credentials.
        reason = str(error)
        print(reason if re.fullmatch(r"[a-z_]{1,64}", reason) else "process_control_failed", file=sys.stderr)
        sys.exit(1)
