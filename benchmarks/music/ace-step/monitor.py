"""Record process and shared GPU memory while executing an isolated benchmark command."""

import argparse
import json
from pathlib import Path
import signal
import subprocess
import time


def fields(path):
    """Read Linux proc key/value counters, converting kB to bytes."""
    values = {}
    try:
        for line in path.read_text().splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            words = value.split()
            if words and words[0].isdigit():
                values[key] = int(words[0]) * (1024 if len(words) > 1 and words[1] == "kB" else 1)
    except (OSError, ValueError):
        pass
    return values


def sample(pid):
    status = fields(Path(f"/proc/{pid}/status"))
    smaps = fields(Path(f"/proc/{pid}/smaps_rollup"))
    mem = fields(Path("/proc/meminfo"))
    gpu = {}
    for directory in Path("/sys/class/kfd/kfd/proc").glob("[0-9]*"):
        try:
            gpu[directory.name] = sum(int(p.read_text()) for p in directory.glob("vram_*"))
        except (OSError, ValueError):
            pass
    drm = {}
    for device in Path("/sys/class/drm").glob("card[0-9]*/device"):
        for name in ("mem_info_vram_used", "mem_info_gtt_used", "gpu_busy_percent"):
            try:
                drm[f"{device.parent.name}_{name}"] = int((device / name).read_text())
            except (OSError, ValueError):
                pass
    return {"monotonic": time.monotonic(), "unix": time.time(), "pid": pid,
            "rss": status.get("VmRSS"), "hwm": status.get("VmHWM"),
            "pss": smaps.get("Pss"), "process_swap": status.get("VmSwap"),
            "system_available": mem.get("MemAvailable"),
            "system_swap_used": mem.get("SwapTotal", 0) - mem.get("SwapFree", 0),
            "kfd_process_bytes": gpu.get(str(pid), 0), "all_kfd_processes": gpu,
            "drm": drm}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=1800)
    parser.add_argument("--minimum-available-gib", type=float, default=20)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[0] == "--" else args.command
    args.output.mkdir(parents=True, exist_ok=True)
    baseline = sample(0)
    (args.output / "command.json").write_text(json.dumps({"command": command,
        "baseline": baseline, "timeout": args.timeout,
        "minimum_available_gib": args.minimum_available_gib}, indent=2))
    start = time.monotonic()
    reason = None
    with (args.output / "process.log").open("w") as log, \
         (args.output / "memory.jsonl").open("w") as memory:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        print(json.dumps({"pid": process.pid, "output": str(args.output)}), flush=True)
        try:
            while process.poll() is None:
                record = sample(process.pid)
                memory.write(json.dumps(record) + "\n")
                memory.flush()
                elapsed = time.monotonic() - start
                if elapsed > args.timeout:
                    reason = "timeout"
                elif record["system_available"] < args.minimum_available_gib * 1024**3:
                    reason = "system_available_below_minimum"
                if reason:
                    process.send_signal(signal.SIGINT)
                    try:
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        process.kill()
                    break
                time.sleep(0.5)
            code = process.wait()
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    summary = {"pid": process.pid, "exit_code": code, "stop_reason": reason,
               "seconds": time.monotonic() - start, "after": sample(0)}
    (args.output / "exit.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary), flush=True)
    raise SystemExit(code if code >= 0 else 1)


if __name__ == "__main__":
    main()
