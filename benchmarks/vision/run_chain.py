"""Reusable CLI entry: image + purpose -> result JSON and reviewable artifacts."""
import argparse
import json
from pathlib import Path

from chain import ImageChains
from chain_client import LocalBackend


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--objective', choices=['ocr', 'describe', 'table', 'formula', 'document', 'judge'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--request-id', required=True)
    parser.add_argument('--input-kind', choices=['auto', 'photo', 'document'], default='auto')
    parser.add_argument('--models', type=Path, default=Path('/srv/ai/evidence/visual-recognition-20261018/models.json'))
    args = parser.parse_args()
    if args.output.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('artifacts must stay outside Git')
    with LocalBackend(args.models, args.output/'logs') as backend:
        result = ImageChains(backend, args.output).run(args.image, args.objective, args.request_id, args.input_kind)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result['status'] == 'failed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
