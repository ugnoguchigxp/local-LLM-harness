#!/usr/bin/env python3
"""Measure demand-only image requests; keep plans, credentials and artifacts external."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import threading
import time
import urllib.request
from pathlib import Path


def host_memory() -> dict:
    values = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in ('MemAvailable', 'SwapFree'):
            values[key + 'Bytes'] = int(value.split()[0]) * 1024
    for line in Path('/proc/vmstat').read_text().splitlines():
        key, value = line.split()
        if key in ('pswpin', 'pswpout'):
            values[key + 'Bytes'] = int(value) * os.sysconf('SC_PAGE_SIZE')
    return values


def unit() -> dict:
    raw = subprocess.check_output(['systemctl', 'show', 'larm-image-qwen21.service',
        '--property=ActiveState,MainPID,ControlGroup,CPUUsageNSec,MemoryPeak'], text=True)
    return dict(line.split('=', 1) for line in raw.splitlines())


def sensor(path: str) -> int | None:
    try:
        return int(Path(path).read_text())
    except (OSError, ValueError):
        return None


def stages(log: str) -> dict:
    patterns = {
        'conditioningSeconds': r'get_learned_condition completed, taking ([0-9.]+)s',
        'samplingSeconds': r'sampling completed, taking ([0-9.]+)s',
        'decodeSeconds': r'decode_first_stage completed, taking ([0-9.]+)s',
        'engineSeconds': r'generate_image completed in ([0-9.]+)s',
    }
    result = {}
    for key, pattern in patterns.items():
        matches = re.findall(pattern, log)
        if matches:
            result[key] = float(matches[-1])
    result['weightLoadSeconds'] = sum(float(x) for x in re.findall(r'loading tensors completed, taking ([0-9.]+)s', log))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--credential-file', type=Path, default=Path('/etc/larm/larm.env'))
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    secret = None
    for line in args.credential_file.read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep and key.strip() == 'LARM_API_TOKEN':
            secret = shlex.split(value)[0]
    if not secret:
        raise RuntimeError('API credential unavailable')
    base = plan.get('baseUrl', 'http://127.0.0.1:9810')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(path, payload=None, binary=False):
        req = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + secret,
            'Content-Type': 'application/json'}, data=json.dumps(payload).encode() if payload else None)
        with opener.open(req, timeout=900) as response:
            return response.status, response.read() if binary else json.load(response)
    from PIL import Image
    import numpy as np
    _, health = request('/health')
    (args.output / 'environment.json').write_text(json.dumps({'plan': plan, 'health': health,
        'initialMemory': host_memory(), 'runnerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}, indent=2))
    for case in plan['cases']:
        before = unit()
        if before['MainPID'] != '0' or before['ActiveState'] not in ('inactive', 'failed'):
            raise RuntimeError('An existing image workload is running')
        payload = {key: case[key] for key in ('prompt', 'width', 'height', 'seed')}
        payload.update(model='qwen-image-2.1-turbo', steps=8, format='png')
        initial = host_memory()
        since = time.time()
        started = time.monotonic()
        done = threading.Event()
        results, errors, samples = [], [], []
        def generate():
            try:
                results.append(request('/v1/images/generations', payload))
            except Exception as error:
                errors.append(error)
            finally:
                done.set()
        print(json.dumps({'event': 'start', 'case': case['id']}), flush=True)
        thread = threading.Thread(target=generate)
        thread.start()
        while not done.wait(0.25):
            state = unit()
            sample = {'elapsedSeconds': time.monotonic() - started, **host_memory(),
                'unitState': state['ActiveState'], 'mainPid': int(state['MainPID']),
                'gpuBusyPercent': sensor('/sys/class/drm/card1/device/gpu_busy_percent'),
                'gpuTemperatureMilliC': sensor('/sys/class/drm/card1/device/hwmon/hwmon5/temp1_input'),
                'gpuPowerMicroW': sensor('/sys/class/drm/card1/device/hwmon/hwmon5/power1_average')}
            group = Path('/sys/fs/cgroup') / state.get('ControlGroup', '').lstrip('/')
            if state.get('ControlGroup'):
                sample['cgroupMemoryBytes'] = sensor(str(group / 'memory.current'))
                try:
                    pids = (group / 'cgroup.procs').read_text().split()
                    sample['processRssBytes'] = sum(int(Path(f'/proc/{pid}/statm').read_text().split()[1]) * os.sysconf('SC_PAGE_SIZE') for pid in pids)
                except OSError:
                    pass
            samples.append(sample)
        thread.join()
        api_seconds = time.monotonic() - started
        final = unit()
        log = subprocess.check_output(['journalctl', '-u', 'larm-image-qwen21.service', '--since', f'@{since:.6f}',
            '-o', 'cat', '--no-pager'], text=True)
        (args.output / (case['id'] + '.log')).write_text(log)
        (args.output / (case['id'] + '-samples.json')).write_text(json.dumps(samples))
        if errors:
            raise errors[0]
        http_status, result = results[0]
        assert http_status == 200 and result['status'] == 'succeeded'
        artifact = result['artifact']
        assert artifact['steps'] == 8 and artifact['modelRevision'] == 'bb25d06bc74119c12207243d68917951e6d9c232'
        assert final['MainPID'] == '0' and final['ActiveState'] == 'inactive'
        download_started = time.monotonic()
        _, data = request(artifact['contentUrl'], binary=True)
        target = args.output / (case['id'] + '.png')
        target.write_bytes(data)
        assert hashlib.sha256(data).hexdigest() == artifact['sha256']
        with Image.open(target) as image:
            assert image.size == (case['width'], case['height'])
            pixel_std = float(np.asarray(image.convert('RGB')).std())
            assert pixel_std > 1
        record = {**case, 'status': 'succeeded', 'apiSeconds': api_seconds,
            'downloadSeconds': time.monotonic() - download_started, 'providerSeconds': result.get('durationMs', 0) / 1000,
            'totalSeconds': time.monotonic() - started, 'initialMemory': initial, 'finalMemory': host_memory(),
            'minimumAvailableBytes': min([initial['MemAvailableBytes']] + [s['MemAvailableBytes'] for s in samples]),
            'peakProcessRssBytes': max([0] + [s.get('processRssBytes', 0) for s in samples]),
            'peakCgroupMemoryBytes': max([0] + [s.get('cgroupMemoryBytes') or 0 for s in samples]),
            'maxGpuTemperatureC': max([0] + [(s['gpuTemperatureMilliC'] or 0) / 1000 for s in samples]),
            'meanGpuBusyPercent': sum(s['gpuBusyPercent'] or 0 for s in samples) / max(1, len(samples)),
            'maxSensorPowerW': max([0] + [(s['gpuPowerMicroW'] or 0) / 1e6 for s in samples]),
            'finalWorkerState': final, 'png': str(target), 'bytes': len(data),
            'sha256': artifact['sha256'], 'pixelStd': pixel_std, 'stages': stages(log), 'artifact': artifact}
        with (args.output / 'results.jsonl').open('a') as file:
            file.write(json.dumps(record, ensure_ascii=False) + '\n')
        print(json.dumps({'event': 'completed', 'case': case['id'], 'apiSeconds': api_seconds,
            'minimumAvailableGiB': record['minimumAvailableBytes'] / 1024**3, 'png': str(target)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
