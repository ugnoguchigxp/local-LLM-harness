"""Start one isolated llama.cpp candidate, run the frozen screen, report, and stop it.

Python standard library only. Engines, weights and output directories stay outside
the source repository. No LARM profile, systemd service or model routing is changed.
"""

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

from client import post, stream
from replay import replay
from report import BASELINE, OFF_BASELINE, markdown, summarize

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
FROZEN_SHA256 = "84f958d16035c4ea7892107f667e409840137b3adecc8a249cfd32fd75d54465"
RESERVED = {"-m", "--model", "--alias", "-a", "--host", "--port", "--path-models",
            "-c", "--ctx-size", "-np", "--parallel", "--reasoning", "-rea",
            "-dev", "--device", "-ngl", "--gpu-layers", "--n-gpu-layers", "--fit",
            "--flash-attn", "-fa", "--threads", "-t", "--batch-size", "-b",
            "--ubatch-size", "-ub", "--cache-type-k", "-ctk", "--cache-type-v", "-ctv",
            "--reasoning-format", "--reasoning-budget", "--jinja", "--metrics", "--no-webui"}


def outside_file(value):
    path = pathlib.Path(value).resolve()
    if not path.is_file() or path.is_relative_to(REPO):
        raise ValueError("engine and weights must be existing files outside the repository")
    return path


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as file:
        while block := file.read(4 * 1024 * 1024):
            result.update(block)
    return result.hexdigest()


def extra_arguments(path):
    values = json.loads(path.read_text()) if path else []
    if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
        raise ValueError("extra args must be a JSON array of argv strings")
    if any(value.split("=", 1)[0] in RESERVED for value in values):
        raise ValueError("extra args cannot override model/alias/listener/context/parallel/reasoning")
    return values


def command(args, alias, port, extra):
    return [str(args.engine), "-m", str(args.weights), "--alias", alias,
            "-dev", args.device, "-ngl", str(args.gpu_layers), "--fit", "off",
            "--flash-attn", "on", "--ctx-size", str(args.context), "--parallel", "4",
            "--batch-size", "2048", "--ubatch-size", "512", "--threads", "16",
            "--cache-type-k", "f16", "--cache-type-v", "f16", "--host", "127.0.0.1",
            "--port", str(port), "--reasoning", args.thinking, "--reasoning-format",
            "deepseek", "--reasoning-budget", "0" if args.thinking == "off" else "-1",
            "--jinja", "--metrics", "--no-webui", *extra]


def verify_reasoning_off(base_url, alias):
    result = stream(base_url, {"model": alias,
                    "messages": [{"role": "user", "content": "日本語で「準備完了」とだけ答えてください。"}],
                    "temperature": 0.1, "top_k": 50, "top_p": 1.0, "min_p": 0.0,
                    "repeat_penalty": 1.05, "seed": 20261015, "max_tokens": 128,
                    "cache_prompt": False, "chat_template_kwargs": {"enable_thinking": False},
                    "stream": True, "stream_options": {"include_usage": True}})
    result["reasoningOffVerified"] = (not result.get("error") and not result.get("reasoning")
        and bool(result.get("content", "").strip()) and result.get("finishReason") == "stop"
        and "<think>" not in result["content"] and "</think>" not in result["content"])
    return result


def reserve_port(requested=0):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", requested))
        return sock.getsockname()[1]


def wait_ready(server, base_url, alias, weights, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError(f"candidate exited with {server.returncode}; inspect server.log")
        try:
            with urllib.request.urlopen(base_url + "/health", timeout=2) as response:
                healthy = json.load(response).get("status") == "ok"
            if healthy:
                with urllib.request.urlopen(base_url + "/props", timeout=2) as response:
                    props = json.load(response)
                if props.get("model_alias") != alias or pathlib.Path(props.get("model_path", "")).resolve() != weights:
                    raise RuntimeError("listener is not the candidate started by this run")
                return props
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            if isinstance(error, urllib.error.HTTPError):
                error.close()
        time.sleep(0.5)
    raise TimeoutError("candidate readiness timed out; inspect server.log")


def stop(server):
    # Only the process group created by this runner; never kill by name/port.
    try:
        os.killpg(server.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        server.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(server.pid, signal.SIGKILL)
        server.wait(timeout=5)


def diagnostics(base_url, raw, output):
    groups = [("schema-none.json", [f"schema-{i}" for i in range(6)], None, "none"),
              ("japanese-seeds.json", ["no-tool-5"], [0, 1, 2], None),
              ("schema-default-seeds.json", ["schema-0"], [0, 1, 2], None)]
    for filename, cases, seeds, choice in groups:
        result = replay(base_url, raw, cases, seeds, choice)
        (output / filename).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    tokens = post(base_url, "/tokenize", {"content":
                  "日本語でローカルAIの評価記録を整理します。都市は東京、気温は18度、会議は15時です。\n" * 100,
                  "add_special": True})["tokens"][:512]
    if len(tokens) != 512:
        raise ValueError("native probe requires 512 input token IDs")
    body = {"prompt": tokens, "n_predict": 128, "ignore_eos": True, "temperature": 0.1,
            "top_k": 50, "top_p": 1.0, "min_p": 0.0, "repeat_penalty": 1.05,
            "seed": 20261015, "cache_prompt": False}
    result = {"request": body, "warmup": post(base_url, "/completion", body),
              "samples": [post(base_url, "/completion", body) for _ in range(3)]}
    (output / "native-speed.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", required=True, type=pathlib.Path)
    parser.add_argument("--weights", required=True, type=pathlib.Path)
    parser.add_argument("--label", required=True, help="model/quantization/variant label")
    parser.add_argument("--thinking", required=True, choices=["on", "off"])
    parser.add_argument("--output-dir", required=True, type=pathlib.Path)
    parser.add_argument("--context", type=int, default=65536, help="total pool for four slots")
    parser.add_argument("--port", type=int, default=0, help="0 chooses a free loopback port")
    parser.add_argument("--device", default="Vulkan0")
    parser.add_argument("--gpu-layers", type=int, default=999)
    parser.add_argument("--extra-args-file", type=pathlib.Path)
    parser.add_argument("--expected-model-sha256")
    parser.add_argument("--startup-timeout", type=int, default=180)
    parser.add_argument("--diagnostics", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        args.engine = outside_file(args.engine)
        args.weights = outside_file(args.weights)
        extra = extra_arguments(args.extra_args_file)
        if not os.access(args.engine, os.X_OK):
            raise ValueError("engine must be executable")
        if args.context < 32768 or args.context % 4 or args.startup_timeout <= 0:
            raise ValueError("context must be >=32768 and divisible by four; timeout must be positive")
        if not 0 <= args.port <= 65535:
            raise ValueError("invalid port")
        output = args.output_dir.resolve()
        if not args.output_dir.is_absolute() or output.is_relative_to(REPO) or output.exists():
            raise ValueError("output-dir must be a new absolute directory outside the repository")
        if digest(HERE / "evaluate.py") != FROZEN_SHA256:
            raise ValueError("frozen suite changed; version it separately before comparing")
        port = reserve_port(args.port)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    alias = "candidate-" + uuid.uuid4().hex
    argv = command(args, alias, port, extra)
    if args.dry_run:
        print(json.dumps({"label": args.label, "command": argv, "outputDirectory": str(output),
                          "contextPerSlot": args.context // 4, "diagnostics": args.diagnostics}, indent=2))
        return
    output.mkdir(parents=True, exist_ok=False)
    manifest = {"label": args.label, "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "status": "preparing", "command": argv, "scriptSha256": FROZEN_SHA256,
                "engineSha256": digest(args.engine),
                "weights": {"path": str(args.weights), "bytes": args.weights.stat().st_size,
                            "mtimeNs": args.weights.stat().st_mtime_ns},
                "configuration": {"contextPool": args.context, "parallel": 4,
                                  "contextPerSlot": args.context // 4, "thinking": args.thinking,
                                  "reasoningBudget": 0 if args.thinking == "off" else -1,
                                  "device": args.device, "cache": "f16/f16", "maxOutputTokens": 4096,
                                  "extraArgs": extra, "baselineContextDiffers": args.context != 32768}}

    def save():
        (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))

    save()
    server = None
    try:
        if args.expected_model_sha256:
            actual = digest(args.weights)
            manifest["weights"]["sha256"] = actual
            if actual.lower() != args.expected_model_sha256.lower():
                raise ValueError("model checksum mismatch")
        version = subprocess.run([str(args.engine), "--version"], capture_output=True, text=True,
                                 timeout=30, check=True)
        manifest["engineVersion"] = version.stdout + version.stderr
        with (output / "server.log").open("w") as log:
            server = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            manifest["serverPid"] = server.pid
            base_url = f"http://127.0.0.1:{port}"
            props = wait_ready(server, base_url, alias, args.weights, args.startup_timeout)
            (output / "props.json").write_text(json.dumps(props, ensure_ascii=False, indent=2))
            if args.thinking == "off":
                preflight = verify_reasoning_off(base_url, alias)
                (output / "reasoning-preflight.json").write_text(json.dumps(preflight, ensure_ascii=False, indent=2))
                manifest["reasoningOffVerified"] = preflight["reasoningOffVerified"]
                manifest["preflightReasoningOffVerified"] = preflight["reasoningOffVerified"]
                if not preflight["reasoningOffVerified"]:
                    raise RuntimeError("reasoning off is ineffective; inspect reasoning-preflight.json")
            manifest["status"] = "evaluating"
            save()
            with (output / "evaluate.log").open("w") as log_eval:
                subprocess.run([sys.executable, str(HERE / "evaluate.py"), "--base-url", base_url,
                                "--model", alias, "--thinking", args.thinking, "--output",
                                str(output / "evaluation.json")], stdout=log_eval,
                               stderr=subprocess.STDOUT, check=True)
            raw = json.loads((output / "evaluation.json").read_text())
            summary = summarize(raw, manifest)
            manifest["reasoningAudit"] = summary["reasoningAudit"]
            if args.thinking == "off":
                manifest["reasoningOffVerified"] = not (summary["reasoningAudit"]["responsesWithReasoning"]
                                                        or summary["reasoningAudit"]["bodyThinkTagLeaks"])
                if not manifest["reasoningOffVerified"]:
                    manifest["warning"] = "Off was requested, but reasoning output or tags appeared; preserve as an observed failure."
            if not summary["complete"]:
                raise RuntimeError("suite incomplete; keep partial evidence for inspection")
            if args.diagnostics:
                manifest["status"] = "diagnostics"
                save()
                diagnostics(base_url, raw, output)
            summary = summarize(raw, manifest)
            (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
            baseline_path = OFF_BASELINE if args.thinking == "off" else BASELINE
            baseline = json.loads(baseline_path.read_text())["runs"]
            manifest["comparisonBaseline"] = baseline_path.name
            (output / "comparison.md").write_text(markdown([*baseline, summary]))
            manifest["status"] = "complete"
    except BaseException as error:
        manifest.update(status="interrupted" if isinstance(error, KeyboardInterrupt) else "failed",
                        error=str(error))
        raise
    finally:
        if server is not None:
            stop(server)
        manifest["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        manifest["ownedProcessStopped"] = server is None or server.poll() is not None
        save()
    print(str(output / "comparison.md"))


if __name__ == "__main__":
    def interrupted(*_):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, interrupted)
    main()
