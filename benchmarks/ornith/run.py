"""Run isolated, sequential backend trials from an external JSON plan.

Plan: [{"name": "candidate", "baseUrl": "http://127.0.0.1:18090",
        "model": "candidate", "command": ["/absolute/llama-server", "..."],
        "artifacts": [{"path": "/absolute/model.gguf", "sha256": "..."}]}]
This runner never changes LARM profiles or system services. It terminates only
the process group it launches. Engine binaries, plans and evidence stay external.
"""

import argparse
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import threading
import time
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--startup-seconds", default=600, type=int)
    args = parser.parse_args()
    root = args.output.resolve()
    repo = pathlib.Path(__file__).resolve().parents[2]
    if not args.output.is_absolute() or root.is_relative_to(repo) or root.exists():
        parser.error("output must be a new absolute directory outside the repository")
    plans = json.loads(args.plan.read_text())
    for plan in plans:
        if not plan["name"].replace("-", "").isalnum():
            parser.error("trial names must be alphanumeric with hyphens")
        url = urllib.parse.urlparse(plan["baseUrl"])
        if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port:
            parser.error("trial URL must be an explicit loopback HTTP address")
        if not pathlib.Path(plan["command"][0]).is_absolute():
            parser.error("engine executable must have an absolute path")
    root.mkdir(parents=True, mode=0o700)
    for name in ["evaluate.py", "run.py"]:
        (root / name).write_text(pathlib.Path(__file__).with_name(name).read_text())
    for plan in plans:
        dest = root / plan["name"]
        dest.mkdir()
        (dest / "plan.json").write_text(json.dumps(plan, indent=2))
        for artifact in plan.get("artifacts", []):
            with open(artifact["path"], "rb") as file:
                actual = hashlib.file_digest(file, "sha256").hexdigest()
            if actual != artifact["sha256"]:
                raise ValueError(f"SHA256 mismatch: {artifact['path']}")
        try:
            urllib.request.urlopen(plan["baseUrl"] + "/health", timeout=2).close()
        except Exception:
            pass
        else:
            raise ValueError("refusing to use an existing server on the trial URL")
        stop = threading.Event()
        started = time.monotonic()
        log = (dest / "server.log").open("x")
        env = os.environ.copy()
        env.update(plan.get("environment", {}))
        server = subprocess.Popen(plan["command"], env=env, stdout=log,
                                  stderr=subprocess.STDOUT, start_new_session=True)
        sampler = threading.Thread(target=sample, args=(dest, stop, server,
                                   plan.get("minimumAvailableGiB", 0)), daemon=True)
        sampler.start()
        status = {}
        try:
            for _ in range(args.startup_seconds * 2):
                if server.poll() is not None:
                    raise RuntimeError(f"server exited: {server.returncode}")
                try:
                    with urllib.request.urlopen(plan["baseUrl"] + "/health", timeout=2) as response:
                        if response.status == 200:
                            break
                except Exception:
                    time.sleep(0.5)
            else:
                raise RuntimeError("server readiness timed out")
            status["readySeconds"] = time.monotonic() - started
            print(plan["name"], "ready", round(status["readySeconds"], 2), flush=True)
            subprocess.run(["python3", str(pathlib.Path(__file__).with_name("evaluate.py")),
                            "--base-url", plan["baseUrl"], "--model", plan["model"],
                            "--output", str(dest / "evaluation.json")], check=True)
            status["completed"] = True
        except Exception as error:
            status["error"] = str(error)
            print(plan["name"], str(error), flush=True)
        finally:
            # vLLM can leave worker descendants after its parent exits.
            try:
                os.killpg(server.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                server.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait()
            try:
                os.killpg(server.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stop.set()
            sampler.join(timeout=5)
            log.close()
            status["totalSeconds"] = time.monotonic() - started
            (dest / "status.json").write_text(json.dumps(status, indent=2))


def sample(dest, stop, server, minimum_available_gib):
    low_samples = 0
    with (dest / "resources.jsonl").open("x") as file:
        while not stop.is_set():
            mem = {}
            for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
                name, value = line.split(":", 1)
                if name in ["MemAvailable", "SwapFree"]:
                    mem[name + "KiB"] = int(value.split()[0])
            data = {"unixSeconds": time.time(), **mem}
            for path in pathlib.Path("/sys/class/drm").glob("card*/device/mem_info_*_used"):
                try:
                    data[str(path)] = int(path.read_text())
                except (OSError, ValueError):
                    pass
            file.write(json.dumps(data) + "\n")
            file.flush()
            low_samples = (low_samples + 1 if minimum_available_gib and
                           mem.get("MemAvailableKiB", 0) < minimum_available_gib * 1024 * 1024
                           else 0)
            if low_samples >= 3:
                (dest / "memory-floor.json").write_text(json.dumps(data, indent=2))
                try:
                    os.killpg(server.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                return
            stop.wait(0.5)


if __name__ == "__main__":
    main()
