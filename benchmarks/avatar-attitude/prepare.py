"""Download pinned artifacts to an external sandbox, never alter a service/model config."""
import argparse
import json
from huggingface_hub import snapshot_download
from common import ROOT, require_external, sha256, write_json

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--sandbox', required=True)
    p.add_argument('--models', nargs='+', default=['laya', 'verdict', 'ruri30'])
    args = p.parse_args()
    root = require_external(args.sandbox)
    configs = json.loads((ROOT / 'models.json').read_text())
    for key in args.models:
        cfg = configs[key]
        folder = root / 'artifacts' / key
        patterns = ['config.json', 'model.safetensors', '*token*', '*map.json', '*bert_config.json',
                    '*transformers.json', 'modules.json', '1_Pooling/*', '2_Normalize/*']
        if key == 'laya':
            patterns = ['multilingual/encoder/*', 'multilingual/model.safetensors',
                        'multilingual/rl_agent_config.json', 'multilingual/tokenizer/*']
        snapshot_download(cfg['repo'], revision=cfg['revision'], local_dir=folder,
                          allow_patterns=patterns)
        base = folder / 'multilingual' if key == 'laya' else folder
        files = {str(f.relative_to(base)): {'bytes': f.stat().st_size, 'sha256': sha256(f)}
                 for f in sorted(base.rglob('*')) if f.is_file() and '.cache' not in f.parts}
        write_json(root / 'artifacts' / (key + '-manifest.json'), dict(cfg, path=str(base), files=files))
        print(key, cfg['revision'], sum(f['bytes'] for f in files.values()), flush=True)
