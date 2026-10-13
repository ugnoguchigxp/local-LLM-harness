"""Small, reproducible Japanese conversation/tool screen (not a quality benchmark).

Usage: python3 benchmarks/ornith/evaluate.py --base-url http://127.0.0.1:18090
       --model ornith-trial --output /srv/ai/evidence/NEW-NAME.json
Only synthetic prompts are sent. Responses and timing evidence stay outside the repo.
"""

import argparse
import concurrent.futures
import datetime
import json
import pathlib
import statistics
import time
import urllib.error
import urllib.request
import urllib.parse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--iterations", default=3, type=int, choices=range(1, 11))
    args = parser.parse_args()
    url = urllib.parse.urlparse(args.base_url)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port:
        parser.error("an explicit loopback HTTP URL is required")
    repo = pathlib.Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    if not args.output.is_absolute() or output.is_relative_to(repo) or output.exists():
        parser.error("output must be a new absolute path outside the repository")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "baseUrl": args.base_url,
        "model": args.model,
        "thinking": False,
        "temperature": 0,
        "samples": [],
        "checks": [],
    }

    def request(messages, *, stream=False, max_tokens=512, **extra):
        payload = {
            "model": args.model, "messages": messages, "temperature": 0,
            "max_tokens": max_tokens, "stream": stream,
            "chat_template_kwargs": {"enable_thinking": False},
            **extra,
        }
        if stream:
            payload["stream_options"] = {"include_usage": True}
        started = time.monotonic()
        req = urllib.request.Request(
            args.base_url.rstrip("/") + "/v1/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=240) as response:
                if not stream:
                    data = json.load(response)
                    return {"request": payload, "response": data,
                            "totalMs": (time.monotonic() - started) * 1000}
                first = None
                content, reasoning = "", ""
                usage, timings, finish = {}, {}, None
                for line in response:
                    if not line.startswith(b"data: ") or line.strip() == b"data: [DONE]":
                        continue
                    chunk = json.loads(line[6:])
                    if chunk.get("error"):
                        raise ValueError(str(chunk["error"]))
                    choice = (chunk.get("choices") or [{}])[0]
                    delta = choice.get("delta", {})
                    text = delta.get("content") or ""
                    if text and first is None:
                        first = (time.monotonic() - started) * 1000
                    content += text
                    reasoning += delta.get("reasoning_content") or delta.get("reasoning") or ""
                    usage = chunk.get("usage") or usage
                    timings = chunk.get("timings") or timings
                    finish = choice.get("finish_reason") or finish
                elapsed = (time.monotonic() - started) * 1000
                tokens = usage.get("completion_tokens")
                return {
                    "request": payload, "content": content, "reasoning": reasoning,
                    "firstContentMs": first, "totalMs": elapsed, "usage": usage,
                    "timings": timings, "finishReason": finish,
                    "visibleCharacters": len(content),
                    "endToEndTokS": tokens * 1000 / elapsed if tokens else None,
                    "decodeWindowTokS": ((tokens - 1) * 1000 / (elapsed - first)
                                         if tokens and first is not None and elapsed > first
                                         else None),
                    "visibleCharsS": len(content) * 1000 / elapsed,
                }
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError) as error:
            body = error.read().decode(errors="replace") if isinstance(error, urllib.error.HTTPError) else str(error)
            return {"request": payload, "error": body,
                    "totalMs": (time.monotonic() - started) * 1000}

    def user(text):
        return [{"role": "user", "content": text}]

    def save():
        # An initial exclusive create reserves the destination. Subsequent writes
        # checkpoint this run so a failed server does not lose earlier evidence.
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    with output.open("x") as file:
        file.write("{}")
    report["warmup"] = request(user("日本語で「準備完了」とだけ返してください。"), max_tokens=32)
    save()
    prose = "日本語で、ローカルLLMを対話アプリに組み込む際のレイテンシ設計を説明してください。TTFT、decode速度、同時実行、KV cacheの関係を具体的に述べ、最後に実務上の推奨をまとめてください。"
    code = "Write only Python code, with no markdown: implement merge_intervals, with type hints and docstring, followed by at least 10 assert examples covering empty input, nesting, touching endpoints, negative values, and unsorted input."
    history = "\n".join(f"記録{i}: 会議室の予約状況を確認した。担当者は佐藤、定員は8名、開始時刻は午後3時。" for i in range(150))
    for name, text in [("japanese-short", prose), ("coding-short", code), ("japanese-history", history + "\n以上は参考資料です。" + prose)]:
        for iteration in range(args.iterations):
            # Change the beginning so a server that ignores cache_prompt cannot
            # reuse the long history from the previous timed iteration.
            sample = request(user(f"試験番号{iteration + 1}。\n" + text), stream=True, max_tokens=256,
                             seed=20261012 + iteration, cache_prompt=False)
            sample.update(case=name, iteration=iteration + 1)
            report["samples"].append(sample)
            save()
        print(args.model, name, summarize(report["samples"], name), flush=True)

    def check(name, messages, predicate, **extra):
        result = request(messages, **extra)
        message = ((result.get("response", {}).get("choices") or [{}])[0].get("message") or {})
        try:
            passed = bool(predicate(message)) and "error" not in result
        except (ValueError, KeyError, TypeError, IndexError):
            passed = False
        report["checks"].append({"case": name, "passed": passed, **result})
        save()
        print(args.model, name, passed, flush=True)
        return message

    def content(m):
        return m.get("content") or ""

    check("exact-output", user("説明や記号を付けず、次の文字列だけ返してください：了解しました"),
          lambda m: content(m).strip() == "了解しました")
    check("three-lines", user("日本語で、推論待ち時間を短くする方法を3つ書いて。各行は「・」で始め、全体を3行だけにし、前置きと結論は付けないで。"),
          lambda m: len(content(m).strip().splitlines()) == 3 and all(x.startswith("・") for x in content(m).strip().splitlines()))
    check("followup-memory", [{"role": "user", "content": "私は佐藤です。好きな飲み物はほうじ茶です。"},
                              {"role": "assistant", "content": "佐藤さんはほうじ茶がお好きなのですね。"},
                              {"role": "user", "content": "私の名前と好きな飲み物を一文で答えて。"}],
          lambda m: "佐藤" in content(m) and "ほうじ茶" in content(m))
    check("correction", [{"role": "user", "content": "会議は火曜日の14時です。"},
                         {"role": "assistant", "content": "火曜日の14時ですね。"},
                         {"role": "user", "content": "訂正します。水曜日の15時です。最新の日程だけを答えて。"}],
          lambda m: "水曜" in content(m) and "15" in content(m) and "火曜" not in content(m))
    check("uncertainty", user("私が今朝食べた料理の名前は何ですか？情報が不足している場合は、推測せず「分かりません」とだけ答えて。"),
          lambda m: content(m).strip().rstrip("。") == "分かりません")
    schema = {"type": "object", "properties": {"name": {"type": "string"}, "count": {"type": "integer"}},
              "required": ["name", "count"], "additionalProperties": False}
    check("json-schema", user('名前は「りんご」、数量は3。指定されたJSONだけを返して。'),
          lambda m: json.loads(content(m)) == {"name": "りんご", "count": 3},
          response_format={"type": "json_schema", "json_schema": {"name": "item", "strict": True, "schema": schema}})
    weather = {"type": "function", "function": {"name": "get_weather", "description": "都市の天気を取得する。",
               "parameters": {"type": "object", "properties": {"city": {"type": "string"}},
                              "required": ["city"], "additionalProperties": False}}}
    tools = [weather]

    def calls(m):
        return [(c["function"]["name"], json.loads(c["function"]["arguments"])) for c in m.get("tool_calls", [])]

    messages = user("東京の天気を確認して。")
    m = check("tool-auto", messages,
              lambda m: calls(m) == [("get_weather", {"city": "東京"})], tools=tools, tool_choice="auto")
    if m.get("tool_calls"):
        check("tool-result-followup", messages + [m] + [{"role": "tool", "tool_call_id": c["id"],
              "content": '{"city":"東京","weather":"雨","temperature":18}'} for c in m["tool_calls"]] +
              [{"role": "user", "content": "結果を日本語で一文にして。"}],
              lambda m: "雨" in content(m) and "18" in content(m) and not m.get("tool_calls"), tools=tools)
    check("no-unneeded-tool", user("こんにちは。一言で挨拶してください。天気は調べないで。"),
          lambda m: not m.get("tool_calls") and bool(content(m)), tools=tools, tool_choice="auto")
    check("parallel-tools", user("東京と大阪の天気を両方取得して。一度の応答で2つのツールを呼び出してください。"),
          lambda m: sorted(calls(m), key=lambda x: x[1]["city"]) ==
                    sorted([("get_weather", {"city": "東京"}), ("get_weather", {"city": "大阪"})], key=lambda x: x[1]["city"]),
          tools=tools, tool_choice="auto", parallel_tool_calls=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        parallel = list(pool.map(lambda i: request(user(prose + f"\n質問番号{i}。"), stream=True, max_tokens=128), range(2)))
    report["concurrentTwo"] = parallel
    report["aggregate"] = {name: summarize(report["samples"], name) for name in
                           ["japanese-short", "coding-short", "japanese-history"]}
    report["checksPassed"] = sum(x["passed"] for x in report["checks"])
    report["checksTotal"] = len(report["checks"])
    save()
    print(args.model, f'checks {report["checksPassed"]}/{report["checksTotal"]}', flush=True)


def summarize(samples, name):
    selected = [s for s in samples if s["case"] == name]
    result = {"count": len(selected), "errors": sum("error" in s for s in selected)}
    for key in ["firstContentMs", "totalMs", "decodeWindowTokS", "endToEndTokS", "visibleCharsS"]:
        values = [s[key] for s in selected if s.get(key) is not None]
        result[key + "Median"] = round(statistics.median(values), 3) if values else None
    return result


if __name__ == "__main__":
    main()
