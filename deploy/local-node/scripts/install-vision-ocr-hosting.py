#!/usr/bin/env python3
"""Excalidraw-style fixed registration for two CPU workers; dry-run by default."""
import argparse
import hashlib
import importlib.util
import json
import os
import pwd
import re
import secrets
import shlex
import subprocess
import time
import urllib.request
from pathlib import Path

_spec = importlib.util.spec_from_file_location("excalidraw_registration", Path(__file__).with_name("install-excalidraw-hosting.py"))
_helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helpers)
canonical, digest, safe_path, put = _helpers.canonical, _helpers.digest, _helpers.safe_path, _helpers.put
validate_request_path = _helpers.validate_request_path
STAGE = Path('/srv/ai/local-services-prepared/vision-ocr-production')
MOUNT = Path('/srv/storage/nextorage')
UUID = 'de97577d-c5d3-4b57-ac4b-3753a2f6d331'
CONF = Path('/etc/larm-local-services/vision-ocr')
APP_USER = 'larm-vision-ocr'
CONTROLLER = Path('/usr/local/libexec/larm-process-controller')
MODES = [('ocr-host', 'ocr', 18795, 18794), ('object-recognition-host', 'objects', 18797, 18796)]


def prepared(expected):
    value = json.loads((STAGE / 'prepared.json').read_text())
    if value.get('version') != 1 or value.get('stage') != str(STAGE):
        raise RuntimeError('invalid_preparation')
    computed = digest(json.dumps(sorted(value['files'].items()), separators=(',', ':'), ensure_ascii=False).encode())
    if computed != value['digest'] or (expected and computed != expected):
        raise RuntimeError('prepared_digest_changed')
    files = {}
    for name, asset in value['files'].items():
        rel = Path(name)
        if rel.is_absolute() or '..' in rel.parts or not (name.startswith(('release/', 'python/')) or name in {'bun', 'gateway.js', 'process-controller.py', 'process-member.service.in'}):
            raise RuntimeError('invalid_prepared_path')
        path = STAGE / rel
        if path.resolve() != path or not path.is_file():
            raise RuntimeError('prepared_path_changed')
        data = path.read_bytes()
        if digest(data) != asset['sha256']:
            raise RuntimeError('prepared_asset_changed')
        files[name] = (data, asset['executable'])
    for name in ['bun', 'gateway.js', 'process-controller.py', 'process-member.service.in', 'python/bin/python3.12', 'release/vision_ocr/server.py', 'release/web/ocr/index.html', 'release/web/objects/index.html', 'release/models/models.json']:
        if name not in files:
            raise RuntimeError('prepared_asset_missing')
    return computed, files


def native_dependencies(files):
    asset = files.get('release/upstream-build.json')
    if asset is None:
        return {}
    value = json.loads(asset[0])
    packages = value.get('nativePackages')
    if not isinstance(packages, dict) or not 1 <= len(packages) <= 32:
        raise RuntimeError('invalid_native_dependencies')
    for name, version in packages.items():
        if not re.fullmatch(r'[a-z0-9][a-z0-9+.-]{0,127}', name) or not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9.+:~_-]{1,128}', version):
            raise RuntimeError('invalid_native_dependencies')
    return packages


def artifacts(revision, files, daemon_user):
    native_packages = native_dependencies(files)
    release = Path('/opt/larm-local-services/releases/vision-ocr-host') / revision
    python_root = Path('/opt/larm-local-services/runtimes') / ('python-' + revision)
    python = python_root / 'bin/python3.12'
    bun = Path('/opt/larm-local-services/runtimes') / ('bun-' + digest(files['bun'][0])) / 'bun'
    result, modes, manifests, definitions = {}, [], {}, {}
    for name, (data, executable) in files.items():
        if name.startswith('release/'):
            result[release / name.removeprefix('release/')] = (data, 0o755 if executable else 0o644)
        elif name.startswith('python/'):
            result[python_root / name.removeprefix('python/')] = (data, 0o755 if executable else 0o644)
    result[bun] = (files['bun'][0], 0o755)
    result[release / 'gateway.js'] = (files['gateway.js'][0], 0o644)
    result[CONTROLLER] = (files['process-controller.py'][0], 0o755)
    for service_id, mode, port, gateway_port in MODES:
        data_root = MOUNT / 'larm/apps' / service_id
        private = Path('/var/lib/larm-apps') / service_id
        member = f'larm-local-service-{service_id}-app.service'
        substitutions = {'SERVICE_ID': service_id, 'MEMBER_ID': 'app', 'DATA_ROOT': str(data_root), 'MOUNT_UNIT': 'srv-storage-nextorage.mount',
                         'APP_USER': APP_USER, 'RELEASE_ROOT': str(release), 'PRIVATE_ROOT': str(private),
                         'REGISTERED_EXEC_START': f'{python} -m vision_ocr.server', 'STOP_SECONDS': '45',
                         'MEMORY_MAX_BYTES': str(2 * 1024 ** 3), 'CPU_QUOTA_PERCENT': '400', 'TASKS_MAX': '128'}
        text = files['process-member.service.in'][0].decode()
        for key, value in substitutions.items():
            text = text.replace('@' + key + '@', value)
        if re.search(r'@[A-Z_]+@', text):
            raise RuntimeError('unresolved_template')
        text += f'Environment="VISION_OCR_CONFIG={CONF}/{service_id}.json"\nEnvironment="PYTHONPATH={release}:{release}/site-packages"\nEnvironment="OMP_NUM_THREADS=4"\nEnvironment="OPENBLAS_NUM_THREADS=4"\n'
        units = {member: text}
        for action, suffix in [('start', ''), ('stop', '-stop'), ('observe', '-observe')]:
            units[f'larm-local-service-{service_id}{suffix}.service'] = f'[Unit]\nDescription=LARM {service_id} {action}\n[Service]\nType=oneshot\nUser=root\nExecStart=/usr/bin/python3 {CONTROLLER} {service_id} {action}\nTimeoutStartSec=60\nUMask=0077\n'
        gateway_unit = f'larm-{service_id}-gateway.service'
        units[gateway_unit] = f'''[Unit]
Description=LARM {service_id} request gateway
After=larm-daemon.service
Requires=larm-daemon.service
[Service]
Type=simple
User={daemon_user}
Group={daemon_user}
WorkingDirectory={release}
Environment="LARM_HOSTED_GATEWAY_CONFIG={CONF}/{service_id}-gateway.json"
ExecStart={bun} {release}/gateway.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=268435456
TasksMax=64
UMask=0077
[Install]
WantedBy=multi-user.target
'''
        for name, unit in units.items():
            result[Path('/etc/systemd/system') / name] = (unit.encode(), 0o644)
        storage = {'dataRoot': str(data_root), 'mountPoint': str(MOUNT), 'filesystemUuid': UUID, 'minFreeBytes': 2 * 1024 ** 3}
        manifest = {'version': 1, 'serviceId': service_id, 'release': revision, 'user': APP_USER, 'endpoint': f'http://127.0.0.1:{port}',
                    'storage': storage, 'writePaths': [str(data_root / name) for name in ['state', 'data', 'cache', 'work/app']],
                    'assetHashes': {str(path): digest(data) for path, (data, _) in result.items() if str(path).startswith('/opt/') or path == CONTROLLER},
                    'unitHashes': {name: digest(unit.encode()) for name, unit in units.items() if name.startswith('larm-local-service-')},
                    'members': [{'unit': member, 'memoryMaxBytes': 2 * 1024 ** 3, 'tasksMax': 128, 'cpuQuotaPercent': 400}],
                    'ports': [port], 'lifecycleSecret': str(CONF / (service_id + '-lifecycle-token')), 'staleAfterSeconds': 15, 'startSeconds': 45, 'stopSeconds': 45}
        if native_packages:
            manifest['nativePackages'] = native_packages
        manifest['manifestDigest'] = digest(canonical(manifest))
        manifests[service_id] = manifest
        result[Path('/etc/larm-local-services/process') / (service_id + '.json')] = (canonical(manifest), 0o644)
        definitions[service_id] = {'node': 'local-node', 'backend': 'systemd-process', 'deployment': {
            'unit': f'larm-local-service-{service_id}.service', 'stopUnit': f'larm-local-service-{service_id}-stop.service',
            'observeUnit': f'larm-local-service-{service_id}-observe.service', 'members': [member], 'release': revision,
            'manifestDigest': manifest['manifestDigest'], 'endpoint': manifest['endpoint'], 'publicEndpoint': manifest['endpoint']},
            'readiness': {'timeoutSeconds': 45, 'path': '/health/ready', 'status': 'ready', 'capabilities': {mode: True}},
            'activity': {'secretRef': service_id + '-lifecycle', 'pollSeconds': 5, 'staleAfterSeconds': 15},
            'lifecycle': {'minInstances': 0, 'idleSeconds': 60, 'leaseSeconds': 120, 'gracefulStopSeconds': 45, 'restartPolicy': 'on-next-ensure'},
            'resources': {'startupReservationBytes': 2 * 1024 ** 3, 'cpuMaxCores': 4, 'maxInstances': 1, 'gpuAccess': False}, 'storage': storage}
        modes.append({'id': service_id, 'mode': mode, 'port': port, 'gatewayPort': gateway_port, 'private': private, 'dataRoot': data_root, 'gatewayUnit': gateway_unit})
    result[CONF / 'services.yaml'] = (canonical({'schemaVersion': 'larm.local-services.v2', 'services': definitions}), 0o644)
    allowed_start = [f'larm-local-service-{service_id}{suffix}.service' for service_id, _, _, _ in MODES for suffix in ['', '-stop', '-observe']]
    allowed_stop = [f'larm-local-service-{service_id}.service' for service_id, _, _, _ in MODES]
    rule = f'''polkit.addRule(function(action, subject) {{
  if (action.id === "org.freedesktop.systemd1.manage-units" && subject.user === "{daemon_user}" && ((action.lookup("verb") === "start" && {json.dumps(allowed_start)}.indexOf(action.lookup("unit")) !== -1) || (action.lookup("verb") === "stop" && {json.dumps(allowed_stop)}.indexOf(action.lookup("unit")) !== -1))) return polkit.Result.YES;
}});
'''
    result[Path('/etc/polkit-1/rules.d/62-larm-vision-ocr-control.rules')] = (rule.encode(), 0o644)
    return result, release, python, bun, modes, manifests


def daemon_environment():
    environment = {}
    # Capture privately; never print the daemon environment or its credentials.
    pid = int(subprocess.check_output(['/usr/bin/systemctl', 'show', 'larm-daemon.service', '-p', 'MainPID', '--value'], text=True).strip())
    if pid <= 0:
        raise RuntimeError('running_larm_required_for_activation')
    for entry in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
        if b'=' in entry:
            key, value = entry.split(b'=', 1)
            environment[key.decode()] = value.decode()
    return environment


def gateway_activation_dropin(gateway_units):
    # Requires on a gateway propagates daemon stops; the reverse Wants edge
    # brings the registered gateways back on restart or a later daemon start.
    return f'[Unit]\nWants={" ".join(gateway_units)}\n[Service]\nEnvironmentFile={CONF}/daemon.env\n'


def start_registered_gateways(dropin_path, gateway_units):
    try:
        subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True)
        subprocess.run(['/usr/bin/systemctl', 'restart', 'larm-daemon.service'], check=True)
        deadline = time.monotonic() + 60
        while True:
            try:
                with urllib.request.urlopen('http://127.0.0.1:9810/ready', timeout=2) as response:
                    if response.status == 200:
                        break
            except Exception:
                pass
            if time.monotonic() > deadline:
                raise RuntimeError('activation_readiness_timeout')
            time.sleep(1)
        subprocess.run(['/usr/bin/systemctl', 'enable', '--now', *gateway_units], check=True)
    except Exception:
        dropin_path.unlink()
        subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True)
        subprocess.run(['/usr/bin/systemctl', 'restart', 'larm-daemon.service'], check=True)
        raise RuntimeError('activation_failed_original_daemon_configuration_restored') from None


def activate(release, python, modes, daemon, include_excalidraw=False):
    environment = daemon_environment()
    current = Path('/srv/ai/apps/larm-current').resolve()
    if 'SystemdProcessBackend' not in (current / 'apps/daemon/src/main.ts').read_text():
        raise RuntimeError('running_release_missing_process_backend')
    definitions = json.loads((CONF / 'services.yaml').read_text())
    principals = json.loads((CONF / 'consumers.json').read_text())
    gateway_units = [m['gatewayUnit'] for m in modes]
    if include_excalidraw:
        excalidraw = Path('/etc/larm-local-services/excalidraw')
        added = json.loads((excalidraw / 'services.yaml').read_text())
        if set(added['services']) != {'excalidraw-host'}:
            raise RuntimeError('invalid_excalidraw_registration')
        subprocess.run(['/usr/bin/python3', str(CONTROLLER), 'excalidraw-host', 'preflight'], check=True)
        definitions['services'].update(added['services'])
        principals = _helpers.merge_hosted_consumers(principals, json.loads((excalidraw / 'consumers.json').read_text()))
        gateway_units.append('larm-excalidraw-gateway.service')
    if environment.get('LARM_LOCAL_SERVICES_ENABLED', 'false').lower() == 'true':
        definition_path = environment.get('LARM_LOCAL_SERVICES_FILE', str(Path(environment.get('LARM_CONFIG_DIR', current / 'config/local-node')) / 'local-services.yaml'))
        old = json.loads(subprocess.check_output([str(python), '-c', 'import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', definition_path], env={'PYTHONPATH': str(release / 'site-packages')}, text=True))
        old_principals = json.loads(Path(environment.get('LARM_LOCAL_SERVICES_PRINCIPALS', '/etc/larm/local-services/consumers.json')).read_text())
        if set(old['services']) & set(definitions['services']):
            raise RuntimeError('existing_registration_conflict')
        definitions['services'] = {**old['services'], **definitions['services']}
        principals = _helpers.merge_hosted_consumers(old_principals, principals)
    put(CONF / 'active-services.json', canonical(definitions), 0o640, daemon.pw_gid)
    put(CONF / 'active-consumers.json', canonical(principals), 0o640, daemon.pw_gid)
    journal = Path(environment.get('LARM_LOCAL_SERVICES_JOURNAL', '/var/lib/larm/local-services/state/journal.json'))
    validate_request_path(journal.parent, daemon.pw_uid)
    if not journal.parent.exists():
        journal.parent.mkdir(parents=True, mode=0o700)
        os.chown(journal.parent, daemon.pw_uid, daemon.pw_gid)
    elif journal.parent.stat().st_uid != daemon.pw_uid:
        raise RuntimeError('journal_directory_not_daemon_owned')
    env = f'LARM_LOCAL_SERVICES_ENABLED=true\nLARM_LOCAL_SERVICES_FILE={CONF}/active-services.json\nLARM_LOCAL_SERVICES_PRINCIPALS={CONF}/active-consumers.json\nLARM_LOCAL_SERVICES_JOURNAL={journal}\n'
    put(CONF / 'daemon.env', env.encode(), 0o640, daemon.pw_gid)
    dropin = gateway_activation_dropin(gateway_units)
    dropin_path = Path('/etc/systemd/system/larm-daemon.service.d/65-vision-ocr-hosting.conf')
    put(dropin_path, dropin.encode())
    start_registered_gateways(dropin_path, gateway_units)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--activate', action='store_true', help='Register with the current LARM and start only gateways; restarts the daemon.')
    parser.add_argument('--include-excalidraw', action='store_true', help='Include the previously installed Excalidraw registration in activation.')
    parser.add_argument('--expected-digest')
    parser.add_argument('--daemon-user', default='ugnoguchi')
    parser.add_argument('--larm-api-token-env-file', default='/etc/larm/larm.env')
    args = parser.parse_args()
    if args.include_excalidraw and not args.activate:
        raise RuntimeError('include_excalidraw_requires_activation')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', args.daemon_user):
        raise RuntimeError('invalid_daemon_user')
    revision, files = prepared(args.expected_digest)
    result, release, python, bun, modes, manifests = artifacts(revision, files, args.daemon_user)
    if not args.apply:
        print(json.dumps({'mode': 'dry-run', 'digest': revision, 'files': len(result), 'serviceIds': list(manifests),
                          'gateways': [f'http://127.0.0.1:{m["gatewayPort"]}' for m in modes], 'activatesLarm': args.activate,
                          'dataRoots': [str(m['dataRoot']) for m in modes]}, indent=2))
        return
    if os.geteuid() != 0 or not args.expected_digest:
        raise RuntimeError('root_and_expected_digest_required')
    api_token = _helpers.hosted_api_token(args.larm_api_token_env_file)
    if args.activate:
        daemon_environment()
    daemon = pwd.getpwnam(args.daemon_user)
    validate_request_path(Path('/var/lib/larm/local-services/requests'), daemon.pw_uid)
    mounted = json.loads(subprocess.check_output(['/usr/bin/findmnt', '--json', '--mountpoint', str(MOUNT), '--output', 'UUID,FSTYPE,OPTIONS'], text=True))['filesystems']
    if len(mounted) != 1 or mounted[0]['uuid'] != UUID or mounted[0]['fstype'] != 'ext4' or 'rw' not in mounted[0]['options'].split(','):
        raise RuntimeError('required_storage_unavailable')
    stats = os.statvfs(MOUNT)
    if stats.f_bavail * stats.f_frsize < 2 * 1024 ** 3:
        raise RuntimeError('storage_capacity_low')
    if CONF.exists() or any(m['dataRoot'].exists() or m['private'].exists() for m in modes):
        raise RuntimeError('initial_install_only_existing_deployment')
    for path, (data, _) in result.items():
        safe_path(path)
        if path.exists() and path.read_bytes() != data:
            raise RuntimeError('existing_file_changed')
    try:
        pwd.getpwnam(APP_USER)
        raise RuntimeError('app_user_already_exists')
    except KeyError:
        pass
    for parent in [MOUNT / 'larm', MOUNT / 'larm/apps', Path('/var/lib/larm-apps')]:
        safe_path(parent)
        parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    subprocess.run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/var/lib/larm-apps/ocr-host/home', '--shell', '/usr/sbin/nologin', APP_USER], check=True)
    app = pwd.getpwnam(APP_USER)
    for m in modes:
        for path in [m['dataRoot'], *[m['dataRoot'] / name for name in ['state', 'data', 'cache', 'work', 'work/app']], m['private'], m['private'] / 'home', m['private'] / 'config']:
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chown(path, app.pw_uid, app.pw_gid)
    for path, (data, mode) in result.items():
        put(path, data, mode)
    owner = secrets.token_urlsafe(48)
    put(CONF / 'client-tokens.json', canonical([owner]), 0o640, daemon.pw_gid)
    models = json.loads(files['release/models/models.json'][0])
    for model in models.values():
        model['path'] = str(release / 'models' / Path(model['path']).name)
    consumers = [_helpers.hosted_api_principal(api_token, [m['id'] for m in modes])]
    for m in modes:
        lifecycle, control = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
        config = {**manifests[m['id']]['storage'], 'mode': m['mode'], 'hostname': '127.0.0.1', 'port': m['port'],
                  'lifecycleToken': lifecycle, 'clients': [{'owner': 'local-owner', 'token': owner}], 'models': models}
        put(CONF / (m['id'] + '.json'), canonical(config), 0o640, app.pw_gid)
        put(CONF / (m['id'] + '-lifecycle-token'), lifecycle.encode(), 0o600)
        put(Path('/etc/larm/local-services/secrets') / (m['id'] + '-lifecycle'), lifecycle.encode(), 0o640, daemon.pw_gid)
        put(CONF / (m['id'] + '-larm-token'), control.encode(), 0o640, daemon.pw_gid)
        consumers.append({'id': m['id'] + '-gateway', 'token': control, 'services': [m['id']]})
        gateway = {'larmBaseUrl': 'http://127.0.0.1:9810', 'larmTokenFile': str(CONF / (m['id'] + '-larm-token')),
                   'larmApiTokenEnvFile': args.larm_api_token_env_file, 'clientTokensFile': str(CONF / 'client-tokens.json'), 'gateway': {'hostname': '127.0.0.1', 'port': m['gatewayPort'],
                   'serviceId': m['id'], 'webRoot': str(release / 'web' / m['mode']), 'allowedEndpoints': [manifests[m['id']]['endpoint']], 'userIdleSeconds': 30, 'renewSeconds': 5}}
        put(CONF / (m['id'] + '-gateway.json'), canonical(gateway), 0o640, daemon.pw_gid)
        subprocess.run(['/usr/sbin/runuser', '-u', APP_USER, '--', '/usr/bin/env', 'PATH=/usr/bin:/bin',
                        f'PYTHONPATH={release}:{release}/site-packages', 'PYTHONDONTWRITEBYTECODE=1', f'VISION_OCR_CONFIG={CONF}/{m["id"]}.json',
                        str(python), '-m', 'vision_ocr.server', '--bootstrap'], check=True)
    put(CONF / 'consumers.json', canonical(consumers), 0o640, daemon.pw_gid)
    observations = Path('/var/lib/larm-local-services/observations')
    safe_path(observations)
    observations.mkdir(parents=True, exist_ok=True, mode=0o755)
    requests = Path('/var/lib/larm/local-services/requests')
    requests.mkdir(parents=True, exist_ok=True, mode=0o700)
    validate_request_path(requests, daemon.pw_uid)
    os.chown(requests, daemon.pw_uid, daemon.pw_gid)
    os.chmod(requests, 0o700)
    subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True)
    for service_id in manifests:
        subprocess.run(['/usr/bin/python3', str(CONTROLLER), service_id, 'preflight'], check=True)
    if args.activate:
        activate(release, python, modes, daemon, args.include_excalidraw)
    put(CONF / 'installation.json', canonical({'release': revision, 'activated': args.activate, 'serviceIds': list(manifests)}))
    print(json.dumps({'registered': True, 'activated': args.activate, 'release': revision, 'connectionKeyFile': str(CONF / 'client-tokens.json'),
                      'modelsInitiallyStopped': True, 'gateways': [m['gatewayPort'] for m in modes]}))


if __name__ == '__main__':
    main()
