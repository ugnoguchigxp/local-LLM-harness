#!/usr/bin/env python3
"""Measure TTFT and streaming cadence from a llama.cpp completion endpoint."""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = round((len(ordered) - 1) * fraction)
    return ordered[index]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8088/completion")
    parser.add_argument("--tokens", type=int, default=128)
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--warmup", action="store_true")
    args = parser.parse_args()

    payload = {
        "prompt": "Write an unbroken numbered list of short Japanese sentences about everyday objects.",
        "n_predict": args.tokens,
        "temperature": 0,
        "seed": 42,
        "ignore_eos": True,
        "stream": True,
    }

    def run_once(run: int, warmup: bool = False) -> dict[str, object]:
        request = urllib.request.Request(
            args.url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        started = time.perf_counter()
        event_times: list[float] = []
        final: dict[str, object] = {}
        with urllib.request.urlopen(request, timeout=3600) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                body = line[6:]
                if body == "[DONE]":
                    continue
                event = json.loads(body)
                if event.get("content"):
                    event_times.append(time.perf_counter())
                if event.get("stop"):
                    final = event

        intervals = [b - a for a, b in zip(event_times, event_times[1:])]
        stable = intervals[9:] if len(intervals) > 9 else []
        first_ten_tps = None
        if len(event_times) >= 10 and event_times[9] > event_times[0]:
            first_ten_tps = 9 / (event_times[9] - event_times[0])
        result = {
            "run": run,
            "warmup": warmup,
            "requested_tokens": args.tokens,
            "stream_events": len(event_times),
            "ttft_ms": (event_times[0] - started) * 1000 if event_times else None,
            "first_10_event_tps": first_ten_tps,
            "stable_event_tps": 1 / statistics.mean(stable) if stable else None,
            "min_instant_event_tps": 1 / max(intervals) if intervals else None,
            "max_instant_event_tps": 1 / min(intervals) if intervals else None,
            "p50_interval_ms": percentile(intervals, 0.50) * 1000 if intervals else None,
            "p95_interval_ms": percentile(intervals, 0.95) * 1000 if intervals else None,
            "wall_ms": (time.perf_counter() - started) * 1000,
            "timings": final.get("timings"),
        }
        return result

    if args.warmup:
        print(json.dumps(run_once(0, warmup=True), ensure_ascii=False))
    for repetition in range(1, args.repetitions + 1):
        print(json.dumps(run_once(repetition), ensure_ascii=False))


if __name__ == "__main__":
    main()
