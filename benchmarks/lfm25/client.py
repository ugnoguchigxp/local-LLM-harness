"""Loopback-only replay client for the frozen 2026-10-15 evaluation requests."""

import json
import time
import urllib.error
import urllib.parse
import urllib.request

from evaluate import corruption


def loopback_url(value):
    url = urllib.parse.urlparse(value)
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
            or url.username or url.password or url.query or url.fragment
            or url.path not in ("", "/")):
        raise ValueError("an explicit loopback HTTP origin is required")
    return value.rstrip("/")


def post(base_url, endpoint, payload, timeout=240):
    req = urllib.request.Request(loopback_url(base_url) + endpoint,
                                 data=json.dumps(payload, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def stream(base_url, payload, timeout=240):
    """Preserve thoughts, partial calls and errors; an incomplete SSE is a failure."""
    req = urllib.request.Request(loopback_url(base_url) + "/v1/chat/completions",
                                 data=json.dumps(payload, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json"})
    started = time.monotonic()
    row = {"request": payload, "content": "", "reasoning": "", "toolCalls": [],
           "firstTokenMs": None, "firstContentMs": None, "firstToolMs": None}
    calls = {}
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            for line in response:
                if not line.startswith(b"data: "):
                    continue
                data = line[6:].strip()
                if data == b"[DONE]":
                    break
                chunk = json.loads(data)
                if chunk.get("error"):
                    raise ValueError(str(chunk["error"]))
                choice = (chunk.get("choices") or [{}])[0]
                delta = choice.get("delta", {})
                text = delta.get("content") or ""
                thought = delta.get("reasoning_content") or delta.get("reasoning") or ""
                elapsed = (time.monotonic() - started) * 1000
                if (text or thought or delta.get("tool_calls")) and row["firstTokenMs"] is None:
                    row["firstTokenMs"] = elapsed
                if text and row["firstContentMs"] is None:
                    row["firstContentMs"] = elapsed
                row["content"] += text
                row["reasoning"] += thought
                for call in delta.get("tool_calls", []):
                    if row["firstToolMs"] is None:
                        row["firstToolMs"] = elapsed
                    item = calls.setdefault(call["index"], {"id": "", "type": "function",
                                            "function": {"name": "", "arguments": ""}})
                    if call.get("id"):
                        item["id"] = call["id"]
                    for key in ("name", "arguments"):
                        item["function"][key] += call.get("function", {}).get(key) or ""
                for key in ("usage", "timings"):
                    if chunk.get(key):
                        row[key] = chunk[key]
                if choice.get("finish_reason"):
                    row["finishReason"] = choice["finish_reason"]
        if not row.get("finishReason"):
            raise ValueError("SSE ended without a finish reason")
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError) as error:
        if isinstance(error, urllib.error.HTTPError):
            with error:
                row["error"] = error.read().decode(errors="replace")
        else:
            row["error"] = str(error)
    row["toolCalls"] = [calls[i] for i in sorted(calls)]
    row["totalMs"] = (time.monotonic() - started) * 1000
    row["corruption"] = corruption(row["content"])
    return row
