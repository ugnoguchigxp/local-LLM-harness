#!/usr/bin/env python3
"""Change only the trial selector; the next Provider start applies the mode."""
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ('fixed', 'on-demand'):
        raise ValueError('usage: set-on-demand-kv-mode.py PRIVATE_ENV fixed|on-demand')
    path = Path(sys.argv[1]).absolute()
    loader = runpy.run_path(str(Path(__file__).with_name('launch-on-demand-kv.py')))['environment']
    data = loader(path)
    fields = ['LARM_PROMPT_CACHE_KEY', 'LARM_PROMPT_CACHE_POLICY', 'LARM_CONTEXT_SLOTS', 'LARM_CONTEXT_DEFAULT_TOKENS', 'LARM_KV_ON_DEMAND']
    data = {key: data[key] for key in fields}
    data['LARM_KV_ON_DEMAND'] = '1' if sys.argv[2] == 'on-demand' else '0'
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', prefix='.mode-', dir=path.parent, delete=False) as stream:
            tmp = Path(stream.name)
            json.dump(data, stream, indent=2); stream.write('\n')
            stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if tmp and tmp.exists(): tmp.unlink()
    print(json.dumps({'selectedMode': sys.argv[2], 'appliesOnNextProviderStart': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('KV mode change failed; credentials suppressed')
