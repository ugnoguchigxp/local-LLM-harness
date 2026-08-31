#!/usr/bin/env python3
"""Dependency-free non-streaming smoke test for an OpenAI-compatible LLM endpoint."""

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
                "stream": False,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )

    with urllib.request.urlopen(request, timeout=300) as response:
        payload = json.load(response)
    text = payload["choices"][0]["message"].get("content", "")
    if not text:
        raise RuntimeError("response did not contain assistant content")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
