#!/usr/bin/env python3
"""Import the provider's pinned synthetic reference bank without generating audio."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import numpy as np

REVISION = "1e857568bfd4f02931aca3988ee773a44d2d26d3"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--samples', type=Path, required=True)
    parser.add_argument('--selected-samples', type=Path,
        default=Path('/srv/ai/results/larm/tts/2026-11-01-audio8-dry-husky-tone-speed143'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    target = args.output.resolve()
    if repo == target or repo in target.parents or args.output.is_symlink():
        parser.error('Voice assets must be outside the source repository')
    manifest = json.loads((repo/'apps/audio8-tts/voice-manifest.json').read_text())
    env = json.loads((args.samples/'environment.json').read_text())
    source_bank = json.loads((args.selected_samples/'voice-bank-v1/manifest.json').read_text())
    if env['revision'] != REVISION or source_bank['model_revision'] != REVISION or manifest['model_revision'] != REVISION:
        parser.error('Reference samples belong to a different Audio8 revision')
    corpus = {r['id']: r for r in json.loads((args.samples/'corpus.json').read_text())}
    metrics = {r['id']: r for r in map(json.loads, (args.samples/'metrics.jsonl').read_text().splitlines())}
    selected = {r['source_case']: r for r in source_bank['voices']}
    assets = []
    for voice in manifest['voices']:
        case = voice['source_case']
        if case in metrics:
            record = metrics[case]
            if not record['finished'] or corpus[case]['text'] != voice['reference_text']:
                parser.error('Reference must have reached EOS with the pinned transcript')
            codes = np.load(args.samples/'audio8'/f'{case}-codes.npy', allow_pickle=False)
            if codes.ndim == 3 and codes.shape[0] == 1:
                codes = codes[0]
            codes = codes[:, :record['frames']]
        elif case in selected:
            source = selected[case]
            if source['reference_text'] != voice['reference_text'] or Path(source['file']).name != source['file']:
                parser.error('Selected reference differs from the pinned transcript or path')
            path = args.selected_samples/'voice-bank-v1'/source['file']
            if path.is_symlink():
                parser.error('Selected reference must not be a symlink')
            data = path.read_bytes()
            if len(data) != source['bytes'] or hashlib.sha256(data).hexdigest() != source['sha256']:
                parser.error('Selected reference checksum mismatch')
            codes = np.load(io.BytesIO(data), allow_pickle=False)
        else:
            parser.error(f'Missing reference source: {case}')
        if codes.ndim != 2 or codes.shape[0] != 10 or not 0 < codes.shape[1] <= 320 or codes.dtype.kind not in 'iu' or codes.min() < 0 or codes.max() > 4095:
            parser.error('Invalid reference codes')
        buffer = io.BytesIO()
        np.save(buffer, codes, allow_pickle=False)
        data = buffer.getvalue()
        if len(data) != voice['bytes'] or hashlib.sha256(data).hexdigest() != voice['sha256']:
            parser.error('Prepared reference differs from the pinned provider configuration')
        assets.append((voice['file'], data))
    assets.append(('manifest.json', (json.dumps(manifest, ensure_ascii=False, indent=2)+'\n').encode()))
    # Validate all sources before writing; keep earlier versioned banks available for rollback.
    target.mkdir(parents=True, exist_ok=True)
    for name, data in assets:
        path = target/name
        if Path(name).name != name or path.is_symlink() or (path.exists() and path.read_bytes() != data):
            parser.error('Refusing to replace a different asset; use a versioned directory')
    for name, data in assets:
        path = target/name
        if not path.exists():
            with path.open('xb') as handle:
                handle.write(data)
    print(target/'manifest.json')


if __name__ == '__main__':
    main()
