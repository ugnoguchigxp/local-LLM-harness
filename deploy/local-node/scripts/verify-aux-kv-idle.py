#!/usr/bin/env python3
"""Observe a real five-minute idle release without touching the deployed Provider."""
from concurrent.futures import ThreadPoolExecutor
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


def request(url, body=None, headers=None, timeout=120):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 headers={'content-type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def main():
    if len(sys.argv) != 4:
        raise SystemExit('usage: verify-aux-kv-idle.py REPOSITORY CANDIDATE NEW_EVIDENCE')
    repo, candidate, evidence = [Path(arg).resolve() for arg in sys.argv[1:]]
    if evidence.exists() or repo == evidence or repo in evidence.parents:
        raise ValueError('evidence must be new and outside repository')
    evidence.mkdir(mode=0o700, parents=True)
    result = {'ok': False, 'snapshots': [], 'cases': [], 'idleReleaseMs': 300000}
    def save():
        (evidence / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
    def idle():
        state = request('http://127.0.0.1:9810/v1/activity', timeout=3)
        if state.get('state') != 'idle' or state.get('activeWorkloads') != 0:
            raise RuntimeError('production became active; stop the isolated test')
    idle()
    available = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))) * 1024
    if available < 64 * 1024**3:
        raise RuntimeError('isolated test requires 64 GiB currently available')
    manifest = json.loads((candidate / 'build-manifest.json').read_text())
    if manifest.get('protocol') != 'larm-aux-kv-idle.v1' or hashlib.sha256((candidate / 'llama-server').read_bytes()).hexdigest() != manifest['executableSha256']:
        raise RuntimeError('candidate digest mismatch')
    code = 'import {parse} from "yaml"; console.log(parse(await Bun.file("config/local-node/llama-swap.yaml").text()).models["ornith15-strix-conversation"].cmd)'
    args = shlex.split(subprocess.check_output(['bun', '-e', code], cwd=repo, text=True))
    private = json.loads(Path(args[2]).read_text())
    private['LARM_PROMPT_CACHE_KEY'] = secrets.token_hex(32)
    env = {**os.environ, **private, 'LARM_KV_ON_DEMAND': '1'}
    args = [str(candidate / 'llama-server'), *args[args.index('-m'):]]
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    args[args.index('--port') + 1] = str(port)
    base = f'http://127.0.0.1:{port}'
    headers = {'x-larm-cache-key': private['LARM_PROMPT_CACHE_KEY']}
    log = (evidence / 'engine.log').open('w')
    process = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT)
    result.update(pid=process.pid, port=port, executableSha256=manifest['executableSha256'])
    def driver_bytes():
        clients = {}
        for path in Path(f'/proc/{process.pid}/fdinfo').iterdir():
            try:
                text = path.read_text()
                client = re.search(r'^drm-client-id:\s*(\d+)', text, re.M)
                if client:
                    clients[client[1]] = sum(int(n) * 1024 for n in re.findall(r'^drm-memory-(?:vram|gtt):\s*(\d+)\s+KiB', text, re.M))
            except OSError:
                pass
        return sum(clients.values())
    def stats(label):
        idle()
        data = request(base + '/larm/cache/invalidate', {'action': 'inspect'}, headers)
        row = {'label': label, 'monotonic': time.monotonic(), 'driverBytes': driver_bytes(), **data}
        result['snapshots'].append(row); save()
        return row
    def scope(label):
        return hashlib.sha256(('auxiliary-idle-acceptance-' + label).encode()).hexdigest()
    def infer(label, capacity, word, lease=300000, stream=False):
        idle()
        prefix = '\n'.join(f'Record {i}: An independent synthetic retention test record.' for i in range(200))
        body = {'model': 'ornith1.5-strix', 'messages': [
            {'role': 'system', 'content': prefix + '\nThe remembered word is ' + word + '. Follow the requested output format.'},
            {'role': 'user', 'content': 'Repeat the remembered word 3000 times separated by spaces.' if stream else 'Return only the remembered word.'}],
            'max_tokens': 2048 if stream else 16, 'temperature': 0, 'cache_prompt': True, 'stream': stream}
        context = {'owner': scope('owner'), 'scope': scope(label), 'instance': scope(str(capacity)),
                   'correlation': secrets.token_hex(32), 'leaseMs': lease}
        call_headers = {**headers, 'x-larm-cache-context': json.dumps(context), 'x-larm-context-tokens': str(capacity)}
        started = time.monotonic()
        if stream:
            body['stream_options'] = {'include_usage': True}
            req = urllib.request.Request(base + '/v1/chat/completions', data=json.dumps(body).encode(),
                headers={'content-type': 'application/json', **call_headers})
            text, chunks, done, finish = '', 0, False, None
            with urllib.request.urlopen(req, timeout=180) as response:
                for line in response:
                    if not line.startswith(b'data:'): continue
                    payload = line[5:].strip()
                    if payload == b'[DONE]': done = True; continue
                    item = json.loads(payload)
                    if 'error' in item: raise RuntimeError('stream reported an inference error')
                    for choice in item.get('choices', []):
                        chunks += 1
                        text += choice.get('delta', {}).get('content') or ''
                        finish = choice.get('finish_reason') or finish
            row = {'label': label, 'stream': True, 'chunks': chunks, 'done': done, 'finish': finish,
                   'answerCorrect': word in text.lower(), 'ms': (time.monotonic() - started) * 1000}
            if not done or finish not in ('stop', 'length') or not row['answerCorrect']:
                raise RuntimeError('invalid SSE completion')
        else:
            data = request(base + '/v1/chat/completions', body, call_headers)
            row = {'label': label, 'stream': False, 'answerCorrect': word in data['choices'][0]['message']['content'].lower(),
                   'finish': data['choices'][0]['finish_reason'], 'cachedTokens': data.get('usage', {}).get('prompt_tokens_details', {}).get('cached_tokens', 0),
                   'ms': (time.monotonic() - started) * 1000}
            if not row['answerCorrect'] or row['finish'] != 'stop': raise RuntimeError('invalid JSON completion')
        result['cases'].append(row); save(); print(json.dumps(row), flush=True)
        return row
    def invalidate(label):
        request(base + '/larm/cache/invalidate', {'scope': scope(label)}, headers)
    def probe(authenticated=True, stream=False):
        idle()
        marker = {'x-larm-kv-probe': '1', **(headers if authenticated else {})}
        body = {'model': 'ornith1.5-strix', 'messages': [{'role': 'user', 'content': '0'}],
                'max_tokens': 1, 'temperature': 0, 'stream': stream}
        if not stream:
            data = request(base + '/v1/chat/completions', body, marker)
            if not data.get('choices'): raise RuntimeError('invalid JSON readiness probe')
        else:
            req = urllib.request.Request(base + '/v1/chat/completions', data=json.dumps(body).encode(),
                headers={'content-type': 'application/json', **marker})
            with urllib.request.urlopen(req, timeout=30) as response: payload = response.read(65536)
            if not re.search(rb'data:\s*\[DONE\]', payload): raise RuntimeError('invalid SSE readiness probe')
    try:
        deadline = time.monotonic() + 120
        while True:
            idle()
            if process.poll() is not None: raise RuntimeError('candidate exited during startup')
            try: request(base + '/health', timeout=2); break
            except (OSError, urllib.error.HTTPError):
                if time.monotonic() >= deadline: raise RuntimeError('candidate startup timeout')
                time.sleep(.5)
        initial = stats('initial')
        if initial['onDemandKv']['allocatedTokens'] != 200192: raise RuntimeError('main baseline was not preserved')
        infer('main', 200000, 'cobalt')
        if infer('main', 200000, 'cobalt')['cachedTokens'] <= 0: raise RuntimeError('main cache was not reused')
        probe(); probe(stream=True)
        after_probe = stats('authenticated-probe-only')
        if after_probe['onDemandKv']['allocatedTokens'] != 200192 or any(s['idleRemainingMs'] for s in after_probe['onDemandKv']['auxiliarySlots']):
            raise RuntimeError('readiness probes retained auxiliary KV')
        if infer('main', 200000, 'cobalt')['cachedTokens'] <= 0: raise RuntimeError('readiness probe displaced the main cache')
        infer('aux-one', 131072, 'amber', lease=1000)
        one = stats('first-auxiliary')
        first_deadline = one['monotonic'] + max(s['idleRemainingMs'] for s in one['onDemandKv']['auxiliarySlots']) / 1000
        infer('aux-two', 131072, 'jade')
        full = stats('two-auxiliaries')
        if full['onDemandKv']['allocatedTokens'] != 462336: raise RuntimeError('auxiliary capacity was not allocated')
        time.sleep(3)
        if stats('short-cache-lease-expired')['onDemandKv']['allocatedTokens'] != 462336:
            raise RuntimeError('cache lease shortened the inference idle grace period')
        refreshed_main = False
        while time.monotonic() < first_deadline - 5:
            remaining = first_deadline - time.monotonic()
            if remaining < 120 and not refreshed_main:
                infer('main', 200000, 'cobalt'); refreshed_main = True
            probe(); probe(stream=True)
            row = stats('waiting-for-five-minutes')
            if row['onDemandKv']['allocatedTokens'] != 462336: raise RuntimeError('auxiliary reclaimed before five minutes')
            print(json.dumps({'stage': 'idle-wait', 'remainingSeconds': round(remaining, 1), 'allocatedTokens': 462336}), flush=True)
            time.sleep(min(20, max(.1, remaining - 5)))
        with ThreadPoolExecutor(max_workers=1) as executor:
            active = executor.submit(infer, 'aux-two', 131072, 'jade', 3000, True)
            while time.monotonic() < first_deadline + 2:
                idle(); time.sleep(.5)
            crossed = stats('one-idle-one-streaming')
            if active.done() or not any(s['processing'] for s in crossed['onDemandKv']['auxiliarySlots']):
                raise RuntimeError('long inference did not cross the idle deadline')
            if crossed['onDemandKv']['allocatedTokens'] != 331264: raise RuntimeError('idle peer was not reclaimed independently')
            if full['driverBytes'] - crossed['driverBytes'] < 512 * 1024**2: raise RuntimeError('driver did not return auxiliary KV memory')
            if infer('main', 200000, 'cobalt')['cachedTokens'] <= 0: raise RuntimeError('main cache was lost during idle shrink')
            active.result(timeout=180)
        completed = stats('long-inference-completed')
        if completed['onDemandKv']['allocatedTokens'] != 331264 or max(s['idleRemainingMs'] for s in completed['onDemandKv']['auxiliarySlots']) < 290000:
            raise RuntimeError('long inference did not receive a fresh five-minute grace period')
        invalidate('aux-two')
        final = stats('explicit-task-release')
        if final['onDemandKv']['allocatedTokens'] != 200192: raise RuntimeError('explicit task release did not reclaim idle KV')
        infer('aux-new', 131072, 'coral')
        if stats('regrown-after-idle')['onDemandKv']['allocatedTokens'] != 331264: raise RuntimeError('released auxiliary could not be reallocated')
        invalidate('aux-new')
        if infer('main', 200000, 'cobalt')['cachedTokens'] <= 0: raise RuntimeError('main cache was lost during regrowth')
        final = stats('final')
        if final['onDemandKv']['failures'] != 0 or process.poll() is not None: raise RuntimeError('native resize failure or restart')
        probe(authenticated=False)
        spoof = stats('unauthenticated-marker-is-inference')
        if spoof['onDemandKv']['allocatedTokens'] != 331264 or max(s['idleRemainingMs'] for s in spoof['onDemandKv']['auxiliarySlots']) < 290000:
            raise RuntimeError('unauthenticated caller spoofed the non-activity marker')
        result.update(ok=True, firstIdleDeadline=first_deadline, final=final,
                      probesDoNotRenewIdle=True, unauthenticatedMarkerRejected=True,
                      reclaimedDriverBytes=full['driverBytes'] - crossed['driverBytes'])
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        process.terminate()
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        log.close(); result['candidateStopped'] = True; save()
    print(json.dumps({'ok': result['ok'], 'reclaimedDriverBytes': result.get('reclaimedDriverBytes')}))


if __name__ == '__main__':
    main()
