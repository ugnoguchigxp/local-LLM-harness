#!/usr/bin/env python3
"""Opt-in launch selector. Mode 0 always executes the untouched fixed-KV engine."""
import json
import os
from pathlib import Path
import re
import stat
import sys


def environment(path):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError('private environment must be owner-only')
        data = json.load(stream)
    required = {'LARM_PROMPT_CACHE_KEY', 'LARM_PROMPT_CACHE_POLICY', 'LARM_CONTEXT_SLOTS', 'LARM_CONTEXT_DEFAULT_TOKENS', 'LARM_KV_ON_DEMAND'}
    if set(data) != required or any(not isinstance(value, str) for value in data.values()):
        raise ValueError('invalid environment fields')
    if not re.fullmatch('[a-f0-9]{64}', data['LARM_PROMPT_CACHE_KEY']) or data['LARM_KV_ON_DEMAND'] not in ('0', '1'):
        raise ValueError('invalid private configuration')
    if len(data['LARM_PROMPT_CACHE_POLICY']) > 4096 or not isinstance(json.loads(data['LARM_PROMPT_CACHE_POLICY']), dict):
        raise ValueError('invalid retention policy')
    slots = data['LARM_CONTEXT_SLOTS']
    default = data['LARM_CONTEXT_DEFAULT_TOKENS']
    if len(slots) > 2048 or not re.fullmatch(r'[0-9]+(?:,[0-9]+)*', slots) or not re.fullmatch('[0-9]+', default):
        raise ValueError('invalid context layout')
    values = list(map(int, slots.split(',')))
    if len(values) != 3 or any(value < 1 or value > 1000000 for value in values) or int(default) not in values:
        raise ValueError('invalid context capacities')
    return {**{key: value for key, value in os.environ.items() if key not in required}, **data}


def main():
    if len(sys.argv) < 4 or any(not Path(arg).is_absolute() for arg in sys.argv[1:4]):
        raise ValueError('usage: launch-on-demand-kv.py PRIVATE_ENV FIXED_ENGINE TRIAL_ENGINE [ENGINE_ARGS]')
    env = environment(sys.argv[1])
    engine = sys.argv[3] if env['LARM_KV_ON_DEMAND'] == '1' else sys.argv[2]
    os.execve(engine, [engine, *sys.argv[4:]], env)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('on-demand KV launch failed; credentials suppressed')
