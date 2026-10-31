#!/usr/bin/env python3
"""Private launch adapter: keep engine credentials out of argv and inference bodies."""
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
            raise ValueError('private retention environment must be owner-only')
        data = json.load(stream)
    required = {'LARM_PROMPT_CACHE_KEY', 'LARM_PROMPT_CACHE_POLICY'}
    optional = {'LARM_CONTEXT_SLOTS', 'LARM_CONTEXT_DEFAULT_TOKENS'}
    if set(data) not in (required, required | optional) or not re.fullmatch('[a-f0-9]{64}', data['LARM_PROMPT_CACHE_KEY']):
        raise ValueError('invalid private retention environment')
    if not isinstance(data['LARM_PROMPT_CACHE_POLICY'], str) or len(data['LARM_PROMPT_CACHE_POLICY']) > 4096:
        raise ValueError('invalid retention policy')
    if optional <= set(data):
        slots, default = data['LARM_CONTEXT_SLOTS'], data['LARM_CONTEXT_DEFAULT_TOKENS']
        if not isinstance(slots, str) or not isinstance(default, str) or len(slots) > 2048 or not re.fullmatch(r'[0-9]+(?:,[0-9]+)*', slots) or not re.fullmatch(r'[0-9]+', default):
            raise ValueError('invalid context pools')
        values = list(map(int, slots.split(',')))
        if len(values) > 256 or any(value < 1 or value > 1000000 for value in values) or int(default) not in values:
            raise ValueError('invalid context pools')
    # A legacy launch must not inherit unrelated mixed-context settings.
    env = {key: value for key, value in os.environ.items() if key not in optional}
    return {**env, **data}


def main():
    if len(sys.argv) < 3 or not Path(sys.argv[1]).is_absolute() or not Path(sys.argv[2]).is_absolute():
        raise ValueError('usage: launch-prompt-retention.py PRIVATE_ENV ENGINE [ENGINE_ARGS]')
    env = environment(sys.argv[1])
    os.execve(sys.argv[2], sys.argv[2:], env)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('private retention launch failed; credentials suppressed')
