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
    if set(data) != {'LARM_PROMPT_CACHE_KEY', 'LARM_PROMPT_CACHE_POLICY'} or not re.fullmatch('[a-f0-9]{64}', data['LARM_PROMPT_CACHE_KEY']):
        raise ValueError('invalid private retention environment')
    if not isinstance(data['LARM_PROMPT_CACHE_POLICY'], str) or len(data['LARM_PROMPT_CACHE_POLICY']) > 4096:
        raise ValueError('invalid retention policy')
    return {**os.environ, **data}


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
