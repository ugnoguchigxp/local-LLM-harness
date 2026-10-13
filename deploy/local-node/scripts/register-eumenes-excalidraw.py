#!/usr/bin/env python3
"""Add separated Eumenes credentials to an existing Excalidraw deployment."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import secrets
import stat
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

_spec = importlib.util.spec_from_file_location('registration_helpers', Path(__file__).with_name('install-excalidraw-hosting.py'))
_helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helpers)
CONF = Path('/etc/larm-local-services/excalidraw')
CONSUMER_ID = 'eumenes-excalidraw'
SERVICE_ID = 'excalidraw-host'


def build_registration(app, client_tokens, active, packaged, credentials):
    """Preserve every existing principal, credential and document owner."""
    consumer_token, api_token = credentials['consumerToken'], credentials['apiToken']
    if consumer_token == api_token or min(len(consumer_token), len(api_token)) < 32:
        raise RuntimeError('credentials_not_separated')
    owner = app['clients'][0]['owner']
    if credentials['owner'] != owner:
        raise RuntimeError('existing_document_owner_changed')
    principal = {'id': CONSUMER_ID, 'token': consumer_token, 'services': [SERVICE_ID]}
    app_client = {'owner': owner, 'token': api_token}
    result = copy.deepcopy([app, client_tokens, active, packaged])
    for entries in result[2:]:
        matches = [p for p in entries if p['id'] == CONSUMER_ID or p['token'] == consumer_token]
        if matches and matches != [principal]:
            raise RuntimeError('existing_consumer_conflict')
        if not matches:
            entries.append(copy.deepcopy(principal))
        if any(p['token'] == api_token for p in entries):
            raise RuntimeError('business_credential_is_control_credential')
    matches = [c for c in result[0]['clients'] if c['token'] == api_token]
    if matches and matches != [app_client]:
        raise RuntimeError('existing_business_credential_conflict')
    if not matches:
        result[0]['clients'].append(app_client)
    if api_token not in result[1]:
        result[1].append(api_token)
    if consumer_token in result[1] or any(c['token'] == consumer_token for c in result[0]['clients']) or consumer_token == app['lifecycleToken'] or api_token == app['lifecycleToken']:
        raise RuntimeError('credential_role_conflict')
    return result


def atomic_write(path, data, mode, uid, gid):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def daemon_environment():
    pid = int(subprocess.check_output(['/usr/bin/systemctl', 'show', 'larm-daemon.service', '-p', 'MainPID', '--value']))
    if pid <= 0:
        raise RuntimeError('running_larm_required')
    return dict(x.decode().split('=', 1) for x in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in x)


def readiness():
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen('http://127.0.0.1:9810/ready', timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('daemon_readiness_timeout')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--activate', action='store_true')
    parser.add_argument('--expected-manifest-digest')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('root_required_to_inspect_credentials')
    if args.activate and not args.apply:
        raise RuntimeError('activation_requires_apply')
    environment = daemon_environment()
    principal_path = Path(environment['LARM_LOCAL_SERVICES_PRINCIPALS'])
    paths = [CONF / 'app.json', CONF / 'client-tokens.json', principal_path, CONF / 'consumers.json']
    for path in paths:
        _helpers.safe_path(path)
        if not stat.S_ISREG(path.lstat().st_mode):
            raise RuntimeError('invalid_configuration_file')
    original = [path.read_bytes() for path in paths]
    app, clients, active, packaged = [json.loads(data) for data in original]
    manifest = json.loads(Path('/etc/larm-local-services/process/excalidraw-host.json').read_text())
    if args.apply and manifest['manifestDigest'] != args.expected_manifest_digest:
        raise RuntimeError('deployment_changed')
    subprocess.run(['/usr/bin/python3', '/usr/local/libexec/larm-process-controller', SERVICE_ID, 'preflight'], check=True)
    credential_path = CONF / 'eumenes-credentials.json'
    if credential_path.exists():
        _helpers.safe_path(credential_path)
        credentials = json.loads(credential_path.read_text())
    else:
        credentials = {'version': 1, 'consumerId': CONSUMER_ID, 'serviceId': SERVICE_ID,
                       'owner': app['clients'][0]['owner'], 'consumerToken': secrets.token_urlsafe(48),
                       'apiToken': secrets.token_urlsafe(48), 'larmBaseUrl': 'http://127.0.0.1:9810',
                       'gatewayBaseUrl': 'http://127.0.0.1:18790'}
    if credentials.get('consumerId') != CONSUMER_ID or credentials.get('serviceId') != SERVICE_ID:
        raise RuntimeError('unexpected_credential_identity')
    forbidden = {v for k, v in environment.items() if 'TOKEN' in k or 'SECRET' in k}
    forbidden.update([app['lifecycleToken'], (CONF / 'larm-token').read_text().strip()])
    if credentials['consumerToken'] in forbidden or credentials['apiToken'] in forbidden:
        raise RuntimeError('credential_role_conflict')
    updated = build_registration(app, clients, active, packaged, credentials)
    summary = {'consumerId': CONSUMER_ID, 'services': [SERVICE_ID], 'credentialsFile': str(credential_path),
               'ownerPreserved': credentials['owner'], 'manifestDigest': manifest['manifestDigest'],
               'mode': 'apply' if args.apply else 'dry-run', 'activatesLarm': args.activate}
    if not args.apply:
        print(json.dumps(summary))
        return
    state = subprocess.check_output(['/usr/bin/systemctl', 'show', 'larm-local-service-excalidraw-app.service', '-p', 'ActiveState', '--value'], text=True).strip()
    if state not in {'inactive', 'failed'}:
        raise RuntimeError('excalidraw_must_be_idle_before_registration')
    if args.activate:
        request = urllib.request.Request('http://127.0.0.1:9810/v1/activity', headers={'Authorization': 'Bearer ' + environment['LARM_API_TOKEN']})
        with urllib.request.urlopen(request, timeout=3) as response:
            activity = json.load(response)
        if activity['activeWorkloads'] != 0:
            raise RuntimeError('wait_for_idle_larm_before_restart')
    snapshots = [(p.stat().st_mode & 0o777, p.stat().st_uid, p.stat().st_gid) for p in paths]
    for path, data in zip(paths, original):
        if path.read_bytes() != data:
            raise RuntimeError('configuration_changed_during_registration')
    backup = Path('/var/lib/larm-local-services') / ('eumenes-excalidraw-' + secrets.token_hex(8))
    backup.mkdir(mode=0o700)
    for i, data in enumerate(original):
        atomic_write(backup / f'{i}.json', data, 0o600, 0, 0)
    if not credential_path.exists():
        _helpers.put(credential_path, _helpers.canonical(credentials), 0o640, principal_path.stat().st_gid)
    try:
        for path, value, (mode, uid, gid) in zip(paths, updated, snapshots):
            atomic_write(path, _helpers.canonical(value), mode, uid, gid)
        if args.activate:
            subprocess.run(['/usr/bin/systemctl', 'restart', 'larm-daemon.service'], check=True)
            readiness()
            subprocess.run(['/usr/bin/systemctl', 'restart', 'larm-excalidraw-gateway.service'], check=True)
    except Exception:
        for path, data, (mode, uid, gid) in zip(paths, original, snapshots):
            atomic_write(path, data, mode, uid, gid)
        if args.activate:
            subprocess.run(['/usr/bin/systemctl', 'restart', 'larm-daemon.service'], check=True)
            readiness()
            subprocess.run(['/usr/bin/systemctl', 'restart', 'larm-excalidraw-gateway.service'], check=True)
        raise RuntimeError('registration_failed_original_configuration_restored') from None
    summary['activated'] = args.activate
    summary['backup'] = str(backup)
    print(json.dumps(summary))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print values parsed from credential-bearing configuration.
        reason = str(error)
        print(reason if reason.replace('_', '').isalnum() and len(reason) < 96 else 'registration_failed', file=__import__('sys').stderr)
        raise SystemExit(1)
