#!/usr/bin/env python3
"""Register a sealed Docling host process. Dry-run unless --apply is supplied."""
import argparse
import hashlib
import importlib.util
import json
import os
import pwd
import re
import secrets
import shlex
import shutil
import subprocess
from pathlib import Path

_spec = importlib.util.spec_from_file_location('hosting', Path(__file__).with_name('install-excalidraw-hosting.py'))
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)
canonical, digest, safe_path, put = helpers.canonical, helpers.digest, helpers.safe_path, helpers.put
CONF = Path('/etc/larm-local-services/docling-desk')
DATA = Path('/srv/storage/nextorage/larm/apps/docling-desk')
MOUNT = Path('/srv/storage/nextorage')
UUID = 'de97577d-c5d3-4b57-ac4b-3753a2f6d331'
PRIVATE = Path('/var/lib/larm-apps/docling-desk')
USER = 'larm-docling'
CONTROLLER = Path('/usr/local/libexec/larm-process-controller')
NATIVE = ['libreoffice-writer', 'libreoffice-impress', 'libreoffice-calc', 'bubblewrap', 'tesseract-ocr',
          'tesseract-ocr-eng', 'tesseract-ocr-jpn', 'fonts-noto-cjk', 'fonts-liberation', 'libgomp1']


def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prepared(stage, expected=None):
    value = json.loads((stage / 'prepared.json').read_text())
    actual = digest(canonical({k: v for k, v in value.items() if k != 'digest'}))
    if value.get('version') != 1 or actual != value.get('digest') or (expected and actual != expected):
        raise RuntimeError('prepared_digest_changed')
    if not re.fullmatch('[a-f0-9]{40}', value.get('sourceRevision', '')):
        raise RuntimeError('invalid_source_revision')
    for name, asset in value['files'].items():
        rel = Path(name)
        if rel.is_absolute() or '..' in rel.parts or str(rel) != name or not (
                name.startswith('release/') or name in {'process-controller.py', 'process-member.service.in'}):
            raise RuntimeError('invalid_prepared_path')
        path = stage / rel
        if path.resolve() != path or not path.is_file() or checksum(path) != asset['sha256']:
            raise RuntimeError('prepared_asset_changed')
    for name in ['release/docling_lifecycle.py', 'release/gateway.js', 'process-controller.py',
                 'process-member.service.in', 'release/site-packages/docling_desk/resources/static/frontend/index.html']:
        if name not in value['files']:
            raise RuntimeError('prepared_asset_missing')
    if set(value['externalAssets']) != {value['python'], value['bun']}:
        raise RuntimeError('invalid_shared_runtime')
    for name, asset in value['externalAssets'].items():
        path = Path(name)
        if not name.startswith('/opt/larm-local-services/runtimes/') or path.resolve() != path:
            raise RuntimeError('invalid_shared_runtime')
        safe_path(path)
        if checksum(path) != asset:
            raise RuntimeError('shared_runtime_changed')
    return value


def active_paths():
    # EnvironmentFile assignments override Environment=, in the systemd file order.
    raw = subprocess.check_output(['systemctl', 'show', 'larm-daemon', '-p', 'Environment', '--value'], text=True)
    env = dict(item.split('=', 1) for item in shlex.split(raw) if '=' in item)
    raw = subprocess.check_output(['systemctl', 'show', 'larm-daemon', '-p', 'EnvironmentFiles', '--value'], text=True)
    for name, optional in re.findall(r'(\S+) \(ignore_errors=(yes|no)\)', raw):
        path = Path(name)
        if not path.exists() and optional == 'yes':
            continue
        for line in path.read_text().splitlines():
            if re.match(r'LARM_LOCAL_SERVICES_(FILE|PRINCIPALS)=', line):
                key, value = line.split('=', 1)
                env[key] = value.strip().strip('"\'')
    return Path(env['LARM_LOCAL_SERVICES_FILE']), Path(env['LARM_LOCAL_SERVICES_PRINCIPALS'])


def artifacts(value, template, daemon_user):
    release = Path('/opt/larm-local-services/releases/docling-desk') / value['digest']
    member = 'larm-local-service-docling-desk-app.service'
    substitutions = {'SERVICE_ID': 'docling-desk', 'MEMBER_ID': 'app', 'DATA_ROOT': str(DATA),
        'MOUNT_UNIT': 'srv-storage-nextorage.mount', 'APP_USER': USER, 'RELEASE_ROOT': str(release),
        'PRIVATE_ROOT': str(PRIVATE), 'REGISTERED_EXEC_START': f'{value["python"]} -m uvicorn docling_lifecycle:create_app --factory --host 127.0.0.1 --port 28766 --workers 1 --no-access-log --no-proxy-headers',
        'STOP_SECONDS': '120', 'MEMORY_MAX_BYTES': str(8 * 1024 ** 3), 'CPU_QUOTA_PERCENT': '400', 'TASKS_MAX': '512'}
    for key, replacement in substitutions.items():
        template = template.replace('@' + key + '@', replacement)
    if re.search(r'@[A-Z_]+@', template):
        raise RuntimeError('unresolved_unit_template')
    # bubblewrap configures loopback in its isolated network namespace via netlink.
    # Keep this allowance specific to Docling's member; no host capabilities are granted.
    template = template.replace('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n',
        'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK\n')
    env = {'PYTHONPATH': f'{release}:{release}/site-packages', 'PYTHONNOUSERSITE': '1',
        'DOCLING_ENV_FILE': '/dev/null', 'DOCLING_DATA_DIR': str(DATA / 'data'),
        'DOCLING_STATE_DIR': str(DATA / 'state'), 'DOCLING_CACHE_DIR': str(DATA / 'cache'),
        'DOCLING_MODELS_DIR': str(release / 'models'), 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
        'HF_HUB_DISABLE_TELEMETRY': '1', 'HF_HOME': str(DATA / 'cache/huggingface'),
        'OMP_NUM_THREADS': '4', 'TOKENIZERS_PARALLELISM': 'false', 'DOCLING_AUTH_MODE': 'larm',
        'LARM_DOCLING_LIFECYCLE_TOKEN_FILE': str(CONF / 'lifecycle-token')}
    template += ''.join(f'Environment="{key}={text}"\n' for key, text in env.items())
    template += f'EnvironmentFile={CONF}/app.env\n'
    units = {member: template}
    for action, suffix in [('start', ''), ('stop', '-stop'), ('observe', '-observe')]:
        units[f'larm-local-service-docling-desk{suffix}.service'] = f'''[Unit]
Description=LARM Docling Desk {action}
[Service]
Type=oneshot
User=root
ExecStart=/usr/bin/python3 {CONTROLLER} docling-desk {action}
TimeoutStartSec=180
UMask=0077
'''
    units['larm-docling-gateway.service'] = f'''[Unit]
Description=LARM Docling Desk on-demand browser gateway
After=larm-daemon.service
[Service]
Type=simple
User={daemon_user}
Group={daemon_user}
WorkingDirectory={release}
Environment=LARM_DOCLING_GATEWAY_CONFIG={CONF}/gateway.json
ExecStart={value['bun']} {release}/gateway.js
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
    assets = {str(release / name.removeprefix('release/')): item['sha256']
              for name, item in value['files'].items() if name.startswith('release/')}
    assets.update(value['externalAssets'])
    assets[str(CONTROLLER)] = value['files']['process-controller.py']['sha256']
    manifest = {'version': 1, 'serviceId': 'docling-desk', 'release': value['digest'], 'user': USER,
        'endpoint': 'http://127.0.0.1:28766',
        'storage': {'dataRoot': str(DATA), 'mountPoint': str(MOUNT), 'filesystemUuid': UUID, 'minFreeBytes': 2147483648},
        'writePaths': [str(DATA / p) for p in ['data', 'state', 'cache', 'work/app']],
        'assetHashes': assets, 'unitHashes': {n: digest(t.encode()) for n, t in units.items() if n.startswith('larm-local-service-')},
        'members': [{'unit': member, 'memoryMaxBytes': 8 * 1024 ** 3, 'tasksMax': 512, 'cpuQuotaPercent': 400}],
        'ports': [28766], 'lifecycleSecret': str(CONF / 'lifecycle-token'), 'staleAfterSeconds': 15,
        'startSeconds': 180, 'stopSeconds': 120}
    manifest['manifestDigest'] = digest(canonical(manifest))
    definition = {'node': 'local-node', 'backend': 'systemd-process', 'deployment': {
        'unit': 'larm-local-service-docling-desk.service', 'stopUnit': 'larm-local-service-docling-desk-stop.service',
        'observeUnit': 'larm-local-service-docling-desk-observe.service', 'members': [member],
        'release': value['digest'], 'manifestDigest': manifest['manifestDigest'],
        'endpoint': manifest['endpoint'], 'publicEndpoint': manifest['endpoint']},
        'readiness': {'timeoutSeconds': 180, 'path': '/health/ready', 'status': 'ready', 'capabilities': {}},
        'activity': {'secretRef': 'docling-lifecycle', 'pollSeconds': 5, 'staleAfterSeconds': 15},
        'lifecycle': {'minInstances': 0, 'idleSeconds': 120, 'leaseSeconds': 300, 'gracefulStopSeconds': 120, 'restartPolicy': 'on-next-ensure'},
        'resources': {'startupReservationBytes': 8 * 1024 ** 3, 'cpuMaxCores': 4, 'maxInstances': 1, 'gpuAccess': False},
        'storage': manifest['storage']}
    return release, units, manifest, definition


def merge_services(existing, definition):
    if existing.get('schemaVersion') != 'larm.local-services.v2' or 'docling-desk' in existing['services']:
        raise RuntimeError('existing_service_conflict')
    return {**existing, 'services': {**existing['services'], 'docling-desk': definition}}


def install_release(stage, release, value):
    safe_path(release)
    if release.exists():
        raise RuntimeError('release_already_exists')
    release.parent.mkdir(parents=True, exist_ok=True)
    incoming = release.with_name('.incoming-' + secrets.token_hex(12))
    incoming.mkdir(mode=0o755)
    try:
        for name, asset in value['files'].items():
            if not name.startswith('release/'):
                continue
            destination = incoming / name.removeprefix('release/')
            destination.parent.mkdir(parents=True, exist_ok=True)
            with os.fdopen(os.open(stage / name, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as src, destination.open('xb') as dst:
                hasher = hashlib.sha256()
                while chunk := src.read(1024 * 1024):
                    hasher.update(chunk); dst.write(chunk)
            if hasher.hexdigest() != asset['sha256']:
                raise RuntimeError('prepared_asset_changed_during_copy')
            destination.chmod(0o755 if asset['executable'] else 0o644)
        incoming.rename(release)
    except BaseException:
        shutil.rmtree(incoming)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, default=Path('/srv/ai/local-services-prepared/docling-desk'))
    parser.add_argument('--expected-digest')
    parser.add_argument('--daemon-user', default='ugnoguchi')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--activate', action='store_true')
    parser.add_argument('--install-native', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch('[a-z_][a-z0-9_-]{0,31}', args.daemon_user):
        raise RuntimeError('invalid_daemon_user')
    stage = args.stage.resolve()
    value = prepared(stage, args.expected_digest)
    template = (stage / 'process-member.service.in').read_text()
    release, units, manifest, definition = artifacts(value, template, args.daemon_user)
    if not args.apply:
        print(json.dumps({'mode': 'dry-run', 'digest': value['digest'], 'sourceRevision': value['sourceRevision'],
            'release': str(release), 'data': str(DATA), 'gateway': 'http://127.0.0.1:28765',
            'nativePackages': NATIVE, 'restartsLarm': args.activate}, indent=2))
        return
    if os.geteuid() != 0 or not args.expected_digest:
        raise RuntimeError('root_and_expected_digest_required')
    for path in [CONF, DATA, PRIVATE, release]:
        safe_path(path)
        if path.exists():
            raise RuntimeError(f'initial_install_only:{path}')
    daemon = pwd.getpwnam(args.daemon_user)
    services_path, principals_path = active_paths()
    current = json.loads(services_path.read_text())
    merged = merge_services(current, definition)
    principals = json.loads(principals_path.read_text())
    api_token = helpers.hosted_api_token('/etc/larm/larm.env')
    gateway_token, lifecycle = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
    principals = helpers.merge_hosted_consumers(principals, [
        {'id': 'docling-gateway', 'token': gateway_token, 'services': ['docling-desk']},
        helpers.hosted_api_principal(api_token, ['docling-desk'])])
    if checksum(CONTROLLER) != value['files']['process-controller.py']['sha256']:
        raise RuntimeError('shared_controller_differs_do_not_overwrite')
    mounted = json.loads(subprocess.check_output(['findmnt', '--json', '--mountpoint', str(MOUNT), '--output', 'TARGET,UUID,FSTYPE,OPTIONS'], text=True))['filesystems']
    if len(mounted) != 1 or mounted[0]['uuid'] != UUID or mounted[0]['fstype'] != 'ext4' or 'rw' not in mounted[0]['options'].split(','):
        raise RuntimeError('required_storage_unavailable')
    if shutil.disk_usage(MOUNT).free < 2147483648:
        raise RuntimeError('storage_capacity_low')
    # Refuse conflicting unit/manifest/activation files before any registration.
    dropin = Path('/etc/systemd/system/larm-daemon.service.d/75-docling-hosting.conf')
    for path in [*[Path('/etc/systemd/system') / n for n in units],
                 Path('/etc/larm-local-services/process/docling-desk.json'), dropin,
                 Path('/etc/polkit-1/rules.d/63-larm-docling-control.rules')]:
        safe_path(path)
        if path.exists():
            raise RuntimeError(f'existing_registration_conflict:{path}')
    try:
        pwd.getpwnam(USER)
        raise RuntimeError('app_user_already_exists')
    except KeyError:
        pass
    if args.install_native:
        subprocess.run(['apt-get', 'update'], check=True)
        subprocess.run(['apt-get', 'install', '-y', '--no-install-recommends', *NATIVE], check=True)
    for name in NATIVE:
        if subprocess.check_output(['dpkg-query', '-W', '-f=${Status}', name], text=True) != 'install ok installed':
            raise RuntimeError(f'native_package_missing:{name}')
    install_release(stage, release, value)
    subprocess.run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', str(PRIVATE / 'home'), '--shell', '/usr/sbin/nologin', USER], check=True)
    app = pwd.getpwnam(USER)
    for path in [DATA, *[DATA / p for p in ['data', 'state', 'cache', 'work', 'work/app']], PRIVATE, PRIVATE / 'home', PRIVATE / 'config']:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(path, app.pw_uid, app.pw_gid)
    for name, content in units.items():
        put(Path('/etc/systemd/system') / name, content.encode())
    put(Path('/etc/larm-local-services/process/docling-desk.json'), canonical(manifest))
    put(CONF / 'lifecycle-token', lifecycle.encode(), 0o640, app.pw_gid)
    put(Path('/etc/larm/local-services/secrets/docling-lifecycle'), lifecycle.encode(), 0o640, daemon.pw_gid)
    put(CONF / 'app.env', f'LARM_API_TOKEN={api_token}\n'.encode(), 0o640, app.pw_gid)
    put(CONF / 'gateway-token', gateway_token.encode(), 0o640, daemon.pw_gid)
    put(CONF / 'gateway.json', canonical({'tokenFile': str(CONF / 'gateway-token'), 'gateway': {
        'port': 28765, 'endpoint': manifest['endpoint'], 'idleSeconds': 60, 'renewSeconds': 15}}), 0o640, daemon.pw_gid)
    put(CONF / 'active-services.json', canonical(merged))
    put(CONF / 'active-consumers.json', canonical(principals), 0o640, daemon.pw_gid)
    put(CONF / 'previous-config.json', canonical({'services': str(services_path), 'principals': str(principals_path)}))
    put(CONF / 'daemon.env', f'LARM_LOCAL_SERVICES_ENABLED=true\nLARM_LOCAL_SERVICES_FILE={CONF}/active-services.json\nLARM_LOCAL_SERVICES_PRINCIPALS={CONF}/active-consumers.json\n'.encode())
    permitted = [n for n in units if n.startswith('larm-local-service-') and n != 'larm-local-service-docling-desk-app.service']
    rule = f'''polkit.addRule(function(action, subject) {{
  if (action.id === "org.freedesktop.systemd1.manage-units" && subject.user === "{args.daemon_user}" && ((action.lookup("verb") === "start" && {json.dumps(permitted)}.indexOf(action.lookup("unit")) !== -1) || (action.lookup("verb") === "stop" && action.lookup("unit") === "larm-local-service-docling-desk.service"))) return polkit.Result.YES;
}});
'''
    put(Path('/etc/polkit-1/rules.d/63-larm-docling-control.rules'), rule.encode())
    fragment = f'[Service]\nEnvironmentFile={CONF}/daemon.env\n'
    put(CONF / 'larm-daemon-dropin.review', fragment.encode())
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['python3', str(CONTROLLER), 'docling-desk', 'preflight'], check=True)
    if args.activate:
        put(dropin, fragment.encode())
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'restart', 'larm-daemon'], check=True)
        subprocess.run(['systemctl', 'enable', '--now', 'larm-docling-gateway'], check=True)
    print(json.dumps({'installed': True, 'activated': args.activate, 'gateway': 'http://127.0.0.1:28765', 'digest': value['digest']}))


if __name__ == '__main__':
    main()
