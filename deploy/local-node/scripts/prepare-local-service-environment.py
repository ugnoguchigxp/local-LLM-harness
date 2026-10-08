#!/usr/bin/env python3
"""Prepare only the host-process foundation. Never install or start an application."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess

REPO = Path(__file__).resolve().parents[3]
CONFIG = REPO / "config/local-node/local-service-environment.json"
DEPLOY = REPO / "deploy/local-node/local-services"
FIXED = {
    "releaseRoot": "/opt/larm-local-services/releases",
    "runtimeRoot": "/opt/larm-local-services/runtimes",
    "privateRoot": "/var/lib/larm-apps",
}
POLICY = {k: False for k in ("installApplications", "startServices", "enableDaemon", "runtimeDownloads", "internalStorageFallback")}


def load(path):
    value = json.loads(path.read_text())
    if set(value) != {"schemaVersion", "node", *FIXED, "storage", "policy"}:
        raise ValueError("unknown or missing environment field")
    if value["schemaVersion"] != "larm.local-service-environment.v1" or value["node"] != "local-node":
        raise ValueError("unsupported environment")
    if any(value[k] != v for k, v in FIXED.items()) or value["policy"] != POLICY or any(type(v) is not bool for v in value["policy"].values()):
        raise ValueError("environment preparation must not install or start applications")
    storage = value["storage"]
    if set(storage) != {"mountPoint", "filesystemUuid", "dataRoot", "prepareCacheRoot", "minFreeBytes"}:
        raise ValueError("invalid storage fields")
    if storage["mountPoint"] != "/srv/storage/nextorage" or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", storage["filesystemUuid"]):
        raise ValueError("explicit storage mount and UUID required")
    for key, suffix in (("dataRoot", "apps"), ("prepareCacheRoot", "prepare-cache")):
        if storage[key] != storage["mountPoint"] + "/larm/" + suffix:
            raise ValueError("fixed environment storage root required")
    if type(storage["minFreeBytes"]) is not int or storage["minFreeBytes"] < 2 * 1024**3:
        raise ValueError("storage reserve must be at least 2 GiB")
    return value


def command(args):
    return subprocess.check_output(args, text=True, timeout=10)


def inspect(value):
    if not Path("/sys/fs/cgroup/cgroup.controllers").exists():
        raise ValueError("cgroup v2 required")
    controllers = Path("/sys/fs/cgroup/cgroup.controllers").read_text().split()
    if not {"memory", "cpu", "pids"}.issubset(controllers):
        raise ValueError("memory/cpu/pids controllers required")
    version = command(["/usr/bin/systemctl", "--version"]).splitlines()[0]
    s = value["storage"]
    mount = Path(s["mountPoint"])
    if mount.resolve() != mount:
        raise ValueError("storage symlink refused")
    mounts = json.loads(command(["/usr/bin/findmnt", "--json", "--mountpoint", str(mount), "--output", "TARGET,UUID,OPTIONS"]))["filesystems"]
    if len(mounts) != 1 or mounts[0]["target"] != str(mount) or mounts[0]["uuid"] != s["filesystemUuid"] or "rw" not in mounts[0]["options"].split(","):
        raise ValueError("required storage absent, read-only or wrong UUID; no fallback")
    fs = os.statvfs(mount)
    free = fs.f_bavail * fs.f_frsize
    if free < s["minFreeBytes"]:
        raise ValueError("storage capacity insufficient")
    # Read-only inspection makes no App directories, users, packages, or units.
    return {"systemd": version, "cgroupControllers": controllers,
            "storageUuid": mounts[0]["uuid"], "storageFreeBytes": free,
            "applicationsInstalledByThisOperation": 0, "policy": value["policy"]}


def root_directory(path, mode=0o755, uid=0, gid=0, allowed_parent_uid=0):
    path = Path(path)
    # Reject replacement of any ancestor, including a path that does not yet exist.
    for ancestor in [path, *path.parents]:
        if ancestor.exists() or ancestor.is_symlink():
            info = ancestor.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise ValueError("untrusted environment directory")
            if ancestor != path and (info.st_uid not in {0, allowed_parent_uid} or info.st_mode & 0o022):
                raise ValueError("writable environment parent")
    if path.exists():
        info = path.stat()
        if info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
            raise ValueError("existing directory permissions differ; no ownership overwrite")
    else:
        path.mkdir(mode=mode)
        os.chown(path, uid, gid)
        path.chmod(mode)


def fixed_file(path, content, mode=0o644):
    path = Path(path)
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or path.read_bytes() != content:
            raise ValueError("existing environment asset differs; no overwrite")
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as file:
        file.write(content)
        file.flush()
        os.fsync(file.fileno())
    path.chmod(mode)


def install(value, daemon_user):
    if os.geteuid() != 0:
        raise ValueError("OS administrator authentication required for protected foundation directories")
    daemon = pwd.getpwnam(daemon_user)
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", daemon_user) or daemon.pw_uid == 0:
        raise ValueError("non-root daemon account required")
    inspect(value)  # Must precede every mkdir: absent external storage creates nothing.
    s = value["storage"]
    directories = ["/opt/larm-local-services", value["runtimeRoot"], value["releaseRoot"], value["privateRoot"],
                   "/etc/larm-local-services", "/etc/larm-local-services/process", "/etc/larm-local-services/templates",
                   "/var/lib/larm-local-services", "/var/lib/larm-local-services/observations", s["mountPoint"] + "/larm", s["dataRoot"]]
    for path in directories:
        root_directory(path)
    root_directory(s["prepareCacheRoot"], 0o700, daemon.pw_uid, daemon.pw_gid)
    if not Path("/var/lib/larm").exists():
        root_directory("/var/lib/larm", 0o755, daemon.pw_uid, daemon.pw_gid)
    root_directory("/var/lib/larm/local-services", 0o700, daemon.pw_uid, daemon.pw_gid, daemon.pw_uid)
    root_directory("/var/lib/larm/local-services/requests", 0o700, daemon.pw_uid, daemon.pw_gid, daemon.pw_uid)
    root_directory("/usr/local/libexec")
    assets = {
        "/usr/local/libexec/larm-process-controller.py": (DEPLOY / "process-controller.py").read_bytes(),
        "/etc/larm-local-services/templates/process-member.service.in": (DEPLOY / "process-member.service.in").read_bytes(),
    }
    for path, content in assets.items():
        fixed_file(path, content, 0o755 if path.endswith(".py") else 0o644)
    record = {**value, "daemonUser": daemon_user,
              "assetHashes": {path: hashlib.sha256(content).hexdigest() for path, content in assets.items()}}
    fixed_file("/etc/larm-local-services/environment.json", (json.dumps(record, sort_keys=True, indent=2) + "\n").encode())
    # No useradd, dependency download, package installation, daemon reload,
    # permission rule, service registration/start, application DB or manifest.
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["check", "install"])
    parser.add_argument("--config", type=Path, default=CONFIG)
    parser.add_argument("--daemon-user", default="ugnoguchi")
    args = parser.parse_args()
    try:
        value = load(args.config)
        result = inspect(value) if args.action == "check" else install(value, args.daemon_user)
        print(json.dumps(result, sort_keys=True, indent=2))
    except (ValueError, OSError, subprocess.SubprocessError, KeyError) as exc:
        parser.exit(1, f"Environment preparation refused: {exc}\n")
