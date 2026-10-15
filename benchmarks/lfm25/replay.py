"""Replay saved cases with an explicit seed or tool-choice change; no real tools run."""

import argparse
import copy
import json
import pathlib

from client import loopback_url, stream

REPO = pathlib.Path(__file__).resolve().parents[2]


def replay(base_url, source, cases, seeds=None, tool_choice=None, model=None):
    rows = source.get("checks", []) + source.get("performance", [])
    selected = [row for row in rows if row.get("case") in cases and row.get("request")]
    missing = set(cases) - {row["case"] for row in selected}
    if missing:
        raise ValueError("missing request cases: " + ", ".join(sorted(missing)))
    results = []
    for row in selected:
        for seed in seeds if seeds is not None else [None]:
            body = copy.deepcopy(row["request"])
            body["stream"] = True
            body["stream_options"] = {"include_usage": True}
            if seed is not None:
                body["seed"] = seed
            if tool_choice is not None:
                body["tool_choice"] = tool_choice
            if model is not None:
                body["model"] = model
            result = stream(base_url, body)
            result.update(case=row["case"], sourceIteration=row.get("iteration"))
            results.append(result)
    return {"kind": "request-replay", "sourceScriptSha256": source.get("scriptSha256"),
            "changes": {"seeds": seeds, "toolChoice": tool_choice, "model": model}, "samples": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, type=loopback_url)
    parser.add_argument("--input", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--case", required=True, action="append", dest="cases")
    parser.add_argument("--seed", type=int, action="append", dest="seeds")
    parser.add_argument("--tool-choice", choices=["auto", "none"])
    parser.add_argument("--model", help="override the saved alias for another isolated server")
    args = parser.parse_args()
    if (not args.output.is_absolute() or args.output.resolve().is_relative_to(REPO)
            or args.output.exists()):
        parser.error("output must be a new absolute path outside the repository")
    source = json.loads(args.input.read_text())
    # Reserve the output before sending requests.
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as file:
        file.write("{}")
    result = replay(args.base_url, source, args.cases, args.seeds, args.tool_choice, args.model)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
