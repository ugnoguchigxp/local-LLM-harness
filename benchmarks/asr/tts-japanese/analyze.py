#!/usr/bin/env python3
"""Keep strict CER and a separate kana CER for orthographic variation."""
import argparse
import importlib.metadata
import json
from pathlib import Path

import pykakasi

import suite


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    converter = pykakasi.kakasi()
    def reading(text):
        # Resolve this corpus's numeric time and food-context reading before
        # dictionary conversion; kakasi otherwise reads 辛く as つらく.
        text = suite.normalize(text).replace("3時", "三時").replace("辛くない", "からくない")
        return suite.normalize("".join(token["hira"] for token in converter.convert(text)))
    result = {"pykakasi_version": importlib.metadata.version("pykakasi"),
              "reading_normalization": "NFKC/punctuation/space normalization, 3時→三時, food-context 辛くない→からくない, then dictionary conversion to hiragana",
              "limitation": "Kana equivalence does not prove semantic equivalence; homophones and names require transcript review.",
              "models": []}
    for path in sorted(args.root.glob("*.jsonl")):
        rows = [json.loads(line) for line in path.read_text().splitlines() if line]
        first = [r for r in rows if r["repeat"] == 0]
        converted = []
        for row in first:
            expected, actual = reading(row["reference"]), reading(row["text"])
            converted.append({**row, "reference_reading": expected, "hypothesis_reading": actual,
                              "reading_edits": suite.distance(expected, actual), "reading_units": len(expected)})
        groups = {}
        for group in ("all", "short", "long"):
            data = [r for r in converted if group == "all" or r["group"] == group]
            measured = [r for r in rows if group == "all" or r["group"] == group]
            groups[group] = {"clips": len(data), "attempts": len(measured),
                             "strict_cer": sum(r["edits"] for r in data) / sum(r["reference_units"] for r in data),
                             "reading_cer": sum(r["reading_edits"] for r in data) / sum(r["reading_units"] for r in data),
                             "reading_exact_clips": sum(r["reading_edits"] == 0 for r in data),
                             "p50_seconds": suite.quantile([r["seconds"] for r in measured], .5),
                             "p95_seconds": suite.quantile([r["seconds"] for r in measured], .95),
                             "rtf_p50": suite.quantile([r["rtf"] for r in measured], .5),
                             "errors": sum(r["error"] is not None for r in measured)}
        model = {"name": path.stem, "groups": groups, "clips": converted,
                 "inconsistent_clips": sum(len({r["text"] for r in rows if r["id"] == clip_id}) > 1 for clip_id in {r["id"] for r in rows})}
        result["models"].append(model)
        print(json.dumps({"name": path.stem, "groups": groups, "inconsistent_clips": model["inconsistent_clips"]}, ensure_ascii=False))
        for row in converted:
            if row["reading_edits"] or row["error"]:
                print(f'  {row["id"]}: reading edits={row["reading_edits"]}: {row["text"]} / {row["error"]}')
    (args.root / "reading-analysis.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
