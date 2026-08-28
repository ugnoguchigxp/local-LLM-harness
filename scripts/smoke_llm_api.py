#!/usr/bin/env python3
"""Dependency-free streaming smoke test for an OpenAI-compatible LLM endpoint."""

import argparse
import json
import sys
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8080/v1")
    parser.add_argument("--model", default="local-model")
    parser.add_argument("--prompt", default="こんにちは。短く自己紹介してください。")
    args = parser.parse_args()

    request = urllib.request.Request(
        f"{args.base_url.rstrip('/')}/chat/completions",
        data=json.dumps(
            {
                "model": args.model,
                "messages": [{"role": "user", "content": args.prompt}],
                "stream": True,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )

    with urllib.request.urlopen(request, timeout=300) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8").strip()
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                break
            payload = json.loads(data)
            text = payload["choices"][0]["delta"].get("content", "")
            sys.stdout.write(text)
            sys.stdout.flush()
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
