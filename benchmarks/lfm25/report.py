"""Build an offline comparison from raw runs and curated historical baselines."""

import argparse
import json
import pathlib
import statistics

BASELINE = pathlib.Path(__file__).with_name("baselines") / "2026-10-15.json"
OFF_BASELINE = BASELINE.with_name("2026-10-15-reasoning-off.json")


def median(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def summarize(raw, manifest=None):
    manifest = manifest or {}
    checks = raw.get("checks", [])
    tool = [r for r in checks if r["category"] not in
            {"json", "constrained-json", "exact-text", "prose"}]
    categories = {}
    for category in sorted({r["category"] for r in checks}):
        rows = [r for r in checks if r["category"] == category]
        categories[category] = {"passed": sum(bool(r.get("passed")) for r in rows), "total": len(rows)}
    performance = {}
    for case in ("short", "history"):
        rows = [r for r in raw.get("performance", []) if r["case"] == case]
        successful = [r for r in rows if not r.get("error") and
                      r.get("finishReason") == "stop" and r.get("content")]
        performance[case] = {
            "samples": len(rows), "answers": len(successful),
            "errors": sum(bool(r.get("error")) for r in rows),
            "truncated": sum(r.get("finishReason") == "length" for r in rows),
            "decodeTokS": median([r.get("timings", {}).get("predicted_per_second") for r in rows]),
            "firstContentMsSuccessful": median([r.get("firstContentMs") for r in successful]),
            "totalMs": median([r.get("totalMs") for r in rows]),
            "outputTokens": median([r.get("usage", {}).get("completion_tokens") for r in rows]),
            "bodyCharacters": median([len(r.get("content", "")) for r in rows]),
        }
    concurrent = raw.get("concurrent", [])
    responses = ([raw.get("warmup", {})] + checks + raw.get("performance", [])
                 + [row for batch in concurrent for row in batch.get("samples", [])])
    captured = [row for row in responses if "reasoning" in row]
    reasoning_audit = {"requested": raw.get("thinking"), "responses": len(captured),
                       "responsesWithReasoning": sum(bool(row.get("reasoning")) for row in captured),
                       "reasoningCharacters": sum(len(row.get("reasoning", "")) for row in captured),
                       "bodyThinkTagLeaks": sum("<think>" in row.get("content", "") or
                                                 "</think>" in row.get("content", "") for row in captured)}
    return {"label": manifest.get("label", raw.get("model", "unknown")),
            "scriptSha256": raw.get("scriptSha256"),
            "configuration": manifest.get("configuration", {}),
            "reasoningAudit": reasoning_audit,
            "complete": len(checks) == 68 and all(p["samples"] == 3 for p in performance.values())
                        and len(concurrent) == 3 and bool(raw.get("summary")),
            "categories": categories,
            "toolRelated": {"passed": sum(bool(r.get("passed")) for r in tool), "total": len(tool)},
            "performance": performance,
            "concurrency": {"passedRuns": sum(bool(r.get("passed")) for r in concurrent),
                            "runs": len(concurrent),
                            "wallMsMedian": median([r["wallMs"] for r in concurrent]),
                            "bodyCharacters": median([len(r.get("content", ""))
                                for batch in concurrent for r in batch.get("samples", [])]),
                            "outputTokens": median([r.get("usage", {}).get("completion_tokens")
                                for batch in concurrent for r in batch.get("samples", [])])},
            "failedCases": [r["case"] for r in checks if not r.get("passed")]}


def markdown(runs):
    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ")

    def number(value, scale=1):
        return "—" if value is None else f"{value / scale:.3f}"

    def fraction(value):
        return f"{value['passed']}/{value['total']}"

    lines = ["# ローカルLLM比較", "", "68項目の模擬課題。時間・速度は中央値。意味の正しさは別途人手で確認する。", "",
             "| 指標 | " + " | ".join(cell(r["label"]) for r in runs) + " |",
             "|---|" + "---:|" * len(runs)]
    metrics = [
        ("短入力 decode tok/s", lambda r: number(r["performance"]["short"]["decodeTokS"])),
        ("短入力 本文開始 秒（成功分）", lambda r: number(r["performance"]["short"]["firstContentMsSuccessful"], 1000)),
        ("短入力 完了 秒", lambda r: number(r["performance"]["short"]["totalMs"], 1000)),
        ("短入力 生成token数（思考込み）", lambda r: number(r["performance"]["short"]["outputTokens"])),
        ("ツール関連判定", lambda r: fraction(r["toolRelated"])),
        ("文字列保持", lambda r: fraction(r["categories"].get("exact-text", {"passed": 0, "total": 0}))),
        ("JSON schema 指定値一致", lambda r: fraction(r["categories"].get("constrained-json", {"passed": 0, "total": 0}))),
        ("4会話完了 秒", lambda r: number(r["concurrency"]["wallMsMedian"], 1000)),
        ("4会話 1応答の本文文字数", lambda r: number(r["concurrency"].get("bodyCharacters"))),
        ("4会話 1応答の生成token数", lambda r: number(r["concurrency"].get("outputTokens"))),
        ("4会話 成功した回数", lambda r: f"{r['concurrency']['passedRuns']}/{r['concurrency']['runs']}"),
        ("思考欄が非空の応答数", lambda r: str(r.get("reasoningAudit", {}).get("responsesWithReasoning", "未集計"))),
        ("本文にthinkタグが出た応答数", lambda r: str(r.get("reasoningAudit", {}).get("bodyThinkTagLeaks", "未集計"))),
        ("履歴付き 本文正常完了", lambda r: f"{r['performance']['history']['answers']}/{r['performance']['history']['samples']}"),
        ("履歴付き 終了 秒（打切り込み）", lambda r: number(r["performance"]["history"]["totalMs"], 1000)),
    ]
    for label, read in metrics:
        lines.append("| " + label + " | " + " | ".join(read(r) for r in runs) + " |")
    lines += ["", "## 比較条件", "",
              "履歴の容量、思考設定、生成上限、量子化、engine、MTP有無の差を確認する。条件が違う列を同条件の優劣と扱わない。", ""]
    for run in runs:
        lines += [f"- {cell(run['label'])}: complete={run['complete']}; "
                  f"suite SHA-256={run['scriptSha256']}; "
                  f"条件={cell(json.dumps(run['configuration'], ensure_ascii=False, sort_keys=True))}"]
    lines += ["", "## 人手確認", "",
              "- 「ねぎらい」の意味、不要な検索、引用符・改行の保持、散文の自然さを読む。",
              "- JSON成功件数だけでgrammarの有効性を判断せず、serverログも確認する。",
              "- 原文・思考・エラーは生JSONで確認する。思考を除いた本文開始と総生成速度を混同しない。", ""]
    lines += ["- 完了時間は出力の長さにも依存する。文字数が違う応答を等量生成の速度比較と解釈しない。", ""]
    for run in runs:
        lines.append(f"- {cell(run['label'])} の不合格: " + ", ".join(run["failedCases"]))
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=pathlib.Path, action="append", default=[])
    parser.add_argument("--baseline", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if not args.input and not args.baseline:
        parser.error("provide --input and/or --baseline")
    runs = json.loads(args.baseline.read_text())["runs"] if args.baseline else []
    for path in args.input:
        manifest_path = path.parent / "manifest.json"
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
        runs.append(summarize(json.loads(path.read_text()), manifest))
    if not args.output.is_absolute() or args.output.resolve().is_relative_to(pathlib.Path(__file__).resolve().parents[2]):
        parser.error("output must be an absolute path outside the repository")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as file:
        file.write(markdown(runs))


if __name__ == "__main__":
    main()
