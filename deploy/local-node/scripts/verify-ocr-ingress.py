#!/usr/bin/env python3
"""Verify only status by default; --exercise explicitly sends synthetic media."""
import argparse
import json
from pathlib import Path
import re
import shlex
import sys
import time
import urllib.error
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin')
    parser.add_argument('--token-env-file', type=Path, default=Path('/etc/larm/larm.env'))
    parser.add_argument('--exercise', action='store_true')
    parser.add_argument('--image', type=Path)
    parser.add_argument('--video', type=Path)
    parser.add_argument('--expected-text', default='12345')
    args = parser.parse_args()
    origin = args.origin or json.loads(Path('/etc/larm-local-services/ocr-ingress/installation.json').read_text())['origin']
    from urllib.parse import urlsplit
    url = urlsplit(origin)
    if url.scheme not in {'http', 'https'} or not url.netloc or url.path or url.query or url.fragment or url.username or url.password:
        raise RuntimeError('gateway_origin_required')
    environment = {}
    for line in args.token_env_file.read_text().splitlines():
        if line.startswith(('LARM_API_TOKEN=', 'LARM_CONTROL_TOKEN=')):
            key, value = line.split('=', 1)
            parsed = shlex.split(value)
            if len(parsed) != 1 or key in environment:
                raise RuntimeError('invalid_token_environment')
            environment[key] = parsed[0]
    token = environment.get('LARM_API_TOKEN') or environment.get('LARM_CONTROL_TOKEN')
    if not token:
        raise RuntimeError('existing_larm_token_required')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    checks = []

    def expect(name, condition):
        if not condition:
            raise RuntimeError('check_failed_' + name)
        checks.append(name)

    def call(path, credential=token, method='GET', data=None, content_type=None, extra=None):
        headers = {'Authorization': 'Bearer ' + credential} if credential else {}
        if content_type:
            headers['Content-Type'] = content_type
        headers.update(extra or {})
        request = urllib.request.Request(origin + path, headers=headers, method=method, data=data)
        try:
            with opener.open(request, timeout=210) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, None

    def status():
        code, value = call('/hosting/status')
        expect('authenticated_status', code == 200 and value.get('id') == 'ocr-host')
        return value

    def upload(file):
        boundary = 'larm-ocr-' + uuid.uuid4().hex
        suffix = file.suffix.lower()
        kind = 'image/png' if suffix == '.png' else 'video/mp4'
        data = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture{suffix}"\r\nContent-Type: {kind}\r\n\r\n'.encode()
                + file.read_bytes() + f'\r\n--{boundary}--\r\n'.encode())
        return call('/api/analyze', method='POST', data=data, content_type='multipart/form-data; boundary=' + boundary)

    def poll(job_id):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            code, value = call('/api/jobs/' + job_id)
            expect('job_lookup', code == 200)
            if value['status'] in {'completed', 'failed', 'cancelled'}:
                return value
            time.sleep(.15)
        raise RuntimeError('job_poll_timed_out')

    before = status()
    for label, credential in [('missing', None), ('invalid', 'invalid-fixture'), ('claim', 'larm_conn_v1.fixture')]:
        expect(label + '_token_rejected', call('/hosting/status', credential=credential)[0] == 401)
    expect('foreign_origin_rejected', call('/hosting/status', extra={'Origin': 'https://invalid.example'})[0] == 403)
    expect('foreign_host_rejected', call('/hosting/status', extra={'Host': 'invalid.example'})[0] == 403)
    expect('internal_route_hidden', call('/internal/larm/activity')[0] == 404)
    after = status()
    expect('status_does_not_start_worker', before['state'] == after['state'] and before['generation'] == after['generation'])
    result = {'origin': origin, 'serviceId': 'ocr-host', 'source': 'current-execution-host', 'before': {k: before[k] for k in ['state', 'generation']}}
    if args.exercise:
        if not args.image or not args.video:
            raise RuntimeError('synthetic_image_and_video_required')
        expect('worker_initially_stopped', after['state'] == 'stopped')
        code, image = upload(args.image)
        expect('image_synchronous_ocr', code == 200 and args.expected_text in image.get('text', ''))
        ready = status()
        expect('on_demand_start', ready['state'] == 'ready' and ready['generation'] == before['generation'] + 1)
        code, job = upload(args.video)
        expect('video_accepted_202', code == 202 and bool(job.get('id')))
        completed = poll(job['id'])
        expect('video_completed', completed['status'] == 'completed' and bool(completed.get('result', {}).get('frames')))
        expect('video_ocr_text', any(args.expected_text in f.get('text', '') for f in completed['result']['frames']))
        code, cancellation = upload(args.video)
        expect('cancel_video_accepted_202', code == 202)
        expect('cancel_accepted', call('/api/jobs/' + cancellation['id'] + '/cancel', method='POST', data=b'')[0] == 200)
        expect('cancel_completed', poll(cancellation['id'])['status'] == 'cancelled')
        for path in ['/api/analyze', '/api/jobs/' + job['id'], '/api/jobs/' + job['id'] + '/cancel']:
            method = 'POST' if path.endswith('/cancel') or path == '/api/analyze' else 'GET'
            expect('unauthenticated_operation_rejected', call(path, credential=None, method=method)[0] == 401)
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            final = status()
            if final['state'] == 'stopped':
                break
            time.sleep(1)
        expect('normal_idle_stop', final['state'] == 'stopped')
        code, retained = call('/api/jobs/' + job['id'])
        expect('completed_result_survives_restart', code == 200 and retained['status'] == 'completed')
        restarted = status()
        expect('restart_generation', restarted['generation'] == ready['generation'] + 1)
        # Let the normal gateway/worker idle policies release this final lookup.
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            final = status()
            if final['state'] == 'stopped':
                break
            time.sleep(1)
        expect('final_idle_stop', final['state'] == 'stopped')
        result['after'] = {k: final[k] for k in ['state', 'generation']}
    result['checks'] = sorted(set(checks))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print exception URLs, response bodies, headers or environment.
        reason = str(error)
        print(reason if re.fullmatch(r'[a-z_]{1,96}', reason) else 'ocr_ingress_verification_failed', file=sys.stderr)
        raise SystemExit(1)
