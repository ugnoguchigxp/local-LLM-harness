#!/usr/bin/env python3
"""Bounded, isolated native acceptance. Keep the current Provider running."""
import hashlib
import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import shlex
import socket
import subprocess
import sys
import time
import re
import urllib.error
import urllib.request


def request(url, body=None, headers=None, timeout=120):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={'content-type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: verify-on-demand-kv.py CANDIDATE EVIDENCE_DIRECTORY')
    candidate, evidence = [Path(x).resolve() for x in sys.argv[1:]]
    repo = Path(__file__).resolve().parents[3]
    if evidence.exists() or repo == evidence or repo in evidence.parents:
        raise SystemExit('evidence must be new and outside repository')
    evidence.mkdir(parents=True, mode=0o700)
    result = {'ok': False, 'cases': [], 'snapshots': []}
    def save():
        (evidence / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
    def idle():
        activity = request('http://127.0.0.1:9810/v1/activity', timeout=3)
        if activity.get('state') != 'idle' or activity.get('activeWorkloads') != 0:
            raise RuntimeError('production workload became active; isolated test stopped')
    idle()
    available = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))) * 1024
    if available < 64 * 1024**3:
        raise RuntimeError('isolated candidate requires at least 64 GiB currently available')
    manifest = json.loads((candidate / 'build-manifest.json').read_text())
    if manifest.get('protocol') != 'larm-on-demand-kv.v1' or hashlib.sha256((candidate / 'llama-server').read_bytes()).hexdigest() != manifest['executableSha256']:
        raise RuntimeError('candidate digest mismatch')
    yaml = 'import {parse} from "yaml"; console.log(parse(await Bun.file("config/local-node/llama-swap.yaml").text()).models["ornith15-strix-conversation"].cmd)'
    args = shlex.split(subprocess.check_output(['bun', '-e', yaml], cwd=repo, text=True))
    original_env = Path(args[2])
    private = json.loads(original_env.read_text())
    private['LARM_PROMPT_CACHE_KEY'] = secrets.token_hex(32)
    env = {**os.environ, **private, 'HIP_VISIBLE_DEVICES': '-1', 'ROCR_VISIBLE_DEVICES': '-1', 'LARM_KV_ON_DEMAND': '1'}
    key = private['LARM_PROMPT_CACHE_KEY']
    args = [str(candidate / 'llama-server'), *args[args.index('-m'):]]
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    args[args.index('--port') + 1] = str(port)
    base = f'http://127.0.0.1:{port}'
    log = (evidence / 'engine.log').open('w')
    process = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT)
    result.update(pid=process.pid, port=port, executableSha256=manifest['executableSha256'])
    headers = {'x-larm-cache-key': key}
    def stats(label):
        idle()
        data = request(base + '/larm/cache/invalidate', {'action': 'inspect'}, headers)
        clients = {}
        for path in Path(f'/proc/{process.pid}/fdinfo').iterdir():
            try:
                text = path.read_text()
                match = re.search(r'^drm-client-id:\s*(\d+)', text, re.M)
                if match:
                    values = re.findall(r'^drm-memory-(vram|gtt):\s*(\d+)\s+KiB', text, re.M)
                    clients[match[1]] = sum(int(value) * 1024 for _, value in values)
            except OSError:
                pass
        result['snapshots'].append({'label': label, 'driverBytes': sum(clients.values()), **data}); save()
        return data['onDemandKv']
    def scope(label):
        return hashlib.sha256(('isolated-kv-fixture-' + label).encode()).hexdigest()
    def chat(label, task, capacity, word, lease=300000, repeat=False):
        idle()
        context = {'owner': scope('owner'), 'scope': scope(task), 'instance': scope(str(capacity)),
                   'correlation': secrets.token_hex(32), 'leaseMs': lease}
        prefix = '\n'.join(f'Record {i}: Independent synthetic benchmark record for cache retention.' for i in range(240))
        body = {'model': 'ornith1.5-strix', 'messages': [
            {'role': 'system', 'content': prefix + '\nThe remembered word is ' + word + '. Follow the requested output format. Do not explain.'},
            {'role': 'user', 'content': 'Repeat the remembered word 100 times separated by spaces.' if repeat else 'Return only the remembered word.'}],
            'max_tokens': 256 if repeat else 16, 'temperature': 0, 'cache_prompt': True}
        started = time.monotonic()
        data = request(base + '/v1/chat/completions', body, {**headers, 'x-larm-cache-context': json.dumps(context), 'x-larm-context-tokens': str(capacity)})
        answer = data['choices'][0]['message']['content']
        usage = data.get('usage', {})
        row = {'label': label, 'ms': (time.monotonic() - started) * 1000,
               'answerCorrect': word in answer.lower(), 'finish': data['choices'][0]['finish_reason'],
               'promptTokens': usage.get('prompt_tokens'), 'cachedTokens': usage.get('prompt_tokens_details', {}).get('cached_tokens'),
               'timings': data.get('timings')}
        result['cases'].append(row); save(); print(json.dumps(row), flush=True)
        if not row['answerCorrect'] or row['finish'] not in (('stop', 'length') if repeat else ('stop',)):
            raise RuntimeError('synthetic answer or completion failed: ' + label)
        return row
    def invalidate(task):
        idle(); request(base + '/larm/cache/invalidate', {'scope': scope(task)}, headers)
    try:
        deadline = time.monotonic() + 120
        while True:
            idle()
            if process.poll() is not None:
                raise RuntimeError('candidate exited during startup')
            try:
                request(base + '/health', timeout=2); break
            except (OSError, urllib.error.HTTPError):
                if time.monotonic() > deadline: raise RuntimeError('candidate startup timeout')
                time.sleep(0.5)
        initial = stats('initial')
        if initial['allocatedTokens'] != 200192: raise RuntimeError('auxiliary KV was preallocated')
        chat('main-cold', 'main', 200000, 'cobalt')
        if chat('main-repeat', 'main', 200000, 'cobalt')['cachedTokens'] <= 0: raise RuntimeError('main cache miss')
        chat('sub-one-cold', 'sub-one', 131072, 'amber')
        if stats('one-sub')['allocatedTokens'] != 331264: raise RuntimeError('first auxiliary growth missing')
        chat('sub-two-cold', 'sub-two', 131072, 'jade')
        if stats('two-subs')['allocatedTokens'] != 462336: raise RuntimeError('second auxiliary growth missing')
        for label, capacity, word in [('main', 200000, 'cobalt'), ('sub-one', 131072, 'amber'), ('sub-two', 131072, 'jade')]:
            if chat(label + '-retained', label, capacity, word)['cachedTokens'] <= 0: raise RuntimeError('cache lost during growth')
        invalidate('sub-one')
        if stats('release-one')['allocatedTokens'] != 331264: raise RuntimeError('first shrink missing')
        if chat('main-after-first-shrink', 'main', 200000, 'cobalt')['cachedTokens'] <= 0: raise RuntimeError('main cache lost on shrink')
        if chat('sub-two-after-first-shrink', 'sub-two', 131072, 'jade')['cachedTokens'] <= 0: raise RuntimeError('peer cache lost on shrink')
        invalidate('sub-two')
        if stats('release-two')['allocatedTokens'] != 200192: raise RuntimeError('baseline shrink missing')
        if chat('main-after-both-shrink', 'main', 200000, 'cobalt')['cachedTokens'] <= 0: raise RuntimeError('main cache lost')
        chat('sub-lease', 'sub-lease', 131072, 'coral', lease=3000)
        deadline = time.monotonic() + 7
        while stats('lease-check')['allocatedTokens'] != 200192:
            if time.monotonic() > deadline: raise RuntimeError('expired auxiliary not reclaimed')
            time.sleep(0.5)
        # Force growth while a retained main request is generating, and prove
        # all three sequences remain independent with one shared model process.
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            jobs = [pool.submit(chat, 'parallel-main', 'main', 200000, 'cobalt', repeat=True),
                    pool.submit(chat, 'parallel-sub-a', 'parallel-a', 131072, 'amber', repeat=True),
                    pool.submit(chat, 'parallel-sub-b', 'parallel-b', 131072, 'jade', repeat=True)]
            for job in jobs: job.result()
        if stats('parallel-three')['allocatedTokens'] != 462336: raise RuntimeError('parallel capacity mismatch')
        invalidate('parallel-a'); invalidate('parallel-b')
        if stats('parallel-release')['allocatedTokens'] != 200192: raise RuntimeError('parallel cleanup failed')
        if chat('main-after-parallel', 'main', 200000, 'cobalt')['cachedTokens'] <= 0: raise RuntimeError('main cache lost after parallel')
        idle()
        cancel_context = {'owner': scope('owner'), 'scope': scope('cancelled'), 'instance': scope('131072'),
                          'correlation': secrets.token_hex(32), 'leaseMs': 300000}
        cancel_body = {'model': 'ornith1.5-strix', 'messages': [
            {'role': 'user', 'content': 'Write the numbers 1 through 500, one per line. Do not stop early.'}],
            'max_tokens': 512, 'stream': True, 'cache_prompt': True}
        req = urllib.request.Request(base + '/v1/chat/completions', data=json.dumps(cancel_body).encode(),
            headers={'content-type': 'application/json', **headers, 'x-larm-cache-context': json.dumps(cancel_context), 'x-larm-context-tokens': '131072'})
        with urllib.request.urlopen(req, timeout=30) as response:
            got_content = False
            for line in response:
                if not line.startswith(b'data: {'): continue
                chunk = json.loads(line[6:])
                if any(choice.get('delta', {}).get('content') for choice in chunk.get('choices', [])):
                    got_content = True; break
            if not got_content: raise RuntimeError('cancellation stream never produced content')
        deadline = time.monotonic() + 10
        while stats('cancel-check')['allocatedTokens'] != 200192:
            if time.monotonic() > deadline: raise RuntimeError('cancelled auxiliary retained its KV')
            time.sleep(0.5)
        result['streamCancellationPassed'] = True
        final = stats('final')
        if final['failures'] != 0 or process.poll() is not None: raise RuntimeError('native KV failure or process restart')
        result['nativeInferencePassed'] = True
        result['final'] = final
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        process.terminate()
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        log.close(); result['candidateStopped'] = True; save()
    idle()
    # This helper exercises a real failed shrink with live KV larger than the
    # target and compares the entire attention + recurrent sequence state.
    with (evidence / 'memory-test.log').open('w') as test_log:
        memory_test = subprocess.run([str(candidate / 'larm-on-demand-kv-memory-test'), args[args.index('-m') + 1]],
            env={**os.environ, 'HIP_VISIBLE_DEVICES': '-1', 'ROCR_VISIBLE_DEVICES': '-1'},
            stdout=test_log, stderr=subprocess.STDOUT, timeout=120)
    result['memoryRollbackTestPassed'] = memory_test.returncode == 0
    if not result['memoryRollbackTestPassed']:
        result['ok'] = False; save(); raise RuntimeError('native memory rollback test failed')
    result['ok'] = True
    save()
    print(json.dumps({'ok': result['ok'], 'final': result.get('final')}))


if __name__ == '__main__':
    main()
