#!/usr/bin/env python3
"""Passive trial monitor: never generate tokens or wake an unloaded Provider."""
import argparse
import datetime
import json
import os
from pathlib import Path
import sys
import time
import urllib.request
import urllib.parse


def classify(snapshot, previous, max_resize_ms):
    if not isinstance(snapshot, dict):
        return 'missing-kv-status'
    if not snapshot.get('enabled'):
        return 'fixed-engine'
    capacity = snapshot.get('allocatedTokens')
    if capacity not in (200192, 331264, 462336):
        return 'unexpected-kv-capacity'
    if snapshot.get('failures', 0) > (previous or {}).get('failures', 0):
        return 'kv-resize-failed'
    if snapshot.get('maxResizeMs', 0) > max_resize_ms and snapshot.get('maxResizeMs', 0) > (previous or {}).get('maxResizeMs', 0):
        return 'kv-resize-slow'
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--private-env', required=True)
    parser.add_argument('--state', required=True)
    parser.add_argument('--model-id', required=True)
    parser.add_argument('--base-url', default='http://127.0.0.1:8083')
    parser.add_argument('--interval', type=float, default=15)
    parser.add_argument('--max-resize-ms', type=float, default=1000)
    args = parser.parse_args()
    if not 5 <= args.interval <= 300 or not 100 <= args.max_resize_ms <= 10000:
        raise ValueError('monitor interval or threshold out of bounds')
    # Reuse the launch adapter's owner-only file validation without printing credentials.
    import runpy
    loader = runpy.run_path(str(Path(__file__).with_name('launch-on-demand-kv.py')))['environment']
    env = loader(args.private_env)
    state_path = Path(args.state).resolve()
    state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    previous = None
    errors = 0
    def request(path, body=None, private=False, base=None):
        headers = {'content-type': 'application/json'}
        if private: headers['x-larm-cache-key'] = env['LARM_PROMPT_CACHE_KEY']
        req = urllib.request.Request((base or args.base_url).rstrip('/') + path,
            data=None if body is None else json.dumps(body).encode(), headers=headers)
        with urllib.request.urlopen(req, timeout=5) as response: return json.load(response)
    def save(status, **values):
        row = {'status': status, 'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'modelId': args.model_id, 'maxResizeMsThreshold': args.max_resize_ms, **values}
        tmp = state_path.with_suffix('.tmp')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream: json.dump(row, stream, indent=2); stream.write('\n')
        os.replace(tmp, state_path)
    save('starting')
    while True:
        try:
            running = request('/running').get('running', [])
            live = next((item for item in running if item.get('model') == args.model_id), None)
            if not live or str(live.get('state', '')).lower() not in ('ready', 'hot'):
                save('waiting-for-provider', snapshot=previous)
                errors = 0
            else:
                # The upstream proxy would start a stopped model if it vanished
                # after /running. Use the observed native loopback port directly.
                proxy = urllib.parse.urlsplit(live.get('proxy', ''))
                if proxy.scheme != 'http' or proxy.hostname not in ('127.0.0.1', 'localhost') or not proxy.port or proxy.username or proxy.password:
                    raise ValueError('invalid native loopback endpoint')
                native = urllib.parse.urlunsplit(proxy)
                props = request('/props', private=True, base=native)
                if props.get('larm_prompt_cache', {}).get('authenticated') is not True:
                    raise ValueError('native authentication failed')
                if props.get('larm_on_demand_kv', {}).get('enabled') is not True:
                    save('fixed-engine')
                    return 0
                data = request('/larm/cache/invalidate', {'action': 'inspect'}, private=True, base=native)
                snapshot = data.get('onDemandKv')
                issue = classify(snapshot, previous, args.max_resize_ms)
                if issue == 'fixed-engine':
                    save('fixed-engine', snapshot=snapshot)
                    return 0
                if issue:
                    save('problem', reason=issue, snapshot=snapshot)
                    print(json.dumps({'status': 'problem', 'reason': issue}), flush=True)
                    return 1
                previous = snapshot
                errors = 0
                save('monitoring', snapshot=snapshot)
        except Exception:
            errors += 1
            if errors >= 3:
                save('problem', reason='monitor-unavailable', consecutiveErrors=errors, snapshot=previous)
                print('{"status":"problem","reason":"monitor-unavailable"}', flush=True)
                return 1
            save('retrying', consecutiveErrors=errors, snapshot=previous)
        time.sleep(args.interval)


if __name__ == '__main__':
    sys.exit(main())
