#!/usr/bin/env python3
"""Initial fixed-path registration only. Does not activate or restart LARM."""
import argparse
import hashlib
import json
import os
import pwd
import re
import secrets
import stat
import subprocess
from pathlib import Path

STAGE = Path('/srv/ai/local-services-prepared/excalidraw-production')
MOUNT = Path('/srv/storage/nextorage')
DATA = MOUNT / 'larm/apps/excalidraw-host'
UUID = 'de97577d-c5d3-4b57-ac4b-3753a2f6d331'
APP_USER = 'larm-excalidraw'
PRIVATE = Path('/var/lib/larm-apps/excalidraw-host')
CONF = Path('/etc/larm-local-services/excalidraw')
CONTROLLER = Path('/usr/local/libexec/larm-process-controller')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def safe_path(path):
    for p in [path, *path.parents]:
        if p.is_symlink():
            raise RuntimeError('symlink_refused')
        if p.exists():
            info = p.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('untrusted_parent')


def validate_request_path(path, daemon_uid):
    # Requests are intentionally daemon-owned; the guarded root helper treats contents as untrusted.
    for p in [path, *path.parents]:
        if p.is_symlink():
            raise RuntimeError('request_root_changed')
        if p.exists():
            info = p.stat()
            if not p.is_dir() or info.st_uid not in {0, daemon_uid} or info.st_mode & 0o022:
                raise RuntimeError('request_root_changed')


def prepared(expected):
    value = json.loads((STAGE / 'prepared.json').read_text())
    if value.get('version') != 1 or value.get('stage') != str(STAGE):
        raise RuntimeError('invalid_preparation')
    files = value['files']
    computed = digest(json.dumps(sorted(files.items()), separators=(',', ':'), ensure_ascii=False).encode())
    if computed != value['digest'] or (expected and computed != expected):
        raise RuntimeError('prepared_digest_changed')
    contents = {}
    for name, checksum in files.items():
        rel = Path(name)
        if rel.is_absolute() or '..' in rel.parts or not (name.startswith('release/') or name in {'bun', 'gateway.js', 'process-controller.py', 'process-member.service.in'}):
            raise RuntimeError('invalid_prepared_path')
        path = STAGE / rel
        if path.resolve() != path or not path.is_file():
            raise RuntimeError('prepared_path_changed')
        data = path.read_bytes()
        if digest(data) != checksum:
            raise RuntimeError('prepared_file_changed')
        contents[name] = data
    for required in ('bun', 'gateway.js', 'process-controller.py', 'process-member.service.in', 'release/server.js', 'release/web/index.html'):
        if required not in contents:
            raise RuntimeError('prepared_file_missing')
    return computed, contents


def artifacts(release_digest, files, daemon_user):
    release = Path('/opt/larm-local-services/releases/excalidraw-host') / release_digest
    runtime = Path('/opt/larm-local-services/runtimes') / ('bun-' + digest(files['bun'])) / 'bun'
    result = {}
    for name, data in files.items():
        if name.startswith('release/'):
            result[release / name.removeprefix('release/')] = data
    result[runtime] = files['bun']
    result[release / 'gateway.js'] = files['gateway.js']
    result[CONTROLLER] = files['process-controller.py']
    member = 'larm-local-service-excalidraw-app.service'
    values = {'SERVICE_ID': 'excalidraw-host', 'MEMBER_ID': 'app', 'DATA_ROOT': str(DATA), 'MOUNT_UNIT': 'srv-storage-nextorage.mount', 'APP_USER': APP_USER, 'RELEASE_ROOT': str(release), 'PRIVATE_ROOT': str(PRIVATE), 'REGISTERED_EXEC_START': f'{runtime} {release}/server.js', 'STOP_SECONDS': '45', 'MEMORY_MAX_BYTES': str(1024 ** 3), 'CPU_QUOTA_PERCENT': '200', 'TASKS_MAX': '256'}
    text = files['process-member.service.in'].decode()
    for key, value in values.items():
        text = text.replace('@' + key + '@', value)
    if re.search(r'@[A-Z_]+@', text):
        raise RuntimeError('unresolved_template')
    text += f'Environment="EXCALIDRAW_HOST_CONFIG={CONF}/app.json"\n'
    units = {member: text}
    for action, suffix in [('start', ''), ('stop', '-stop'), ('observe', '-observe')]:
        units[f'larm-local-service-excalidraw{suffix}.service'] = f'[Unit]\nDescription=LARM Excalidraw {action}\n[Service]\nType=oneshot\nUser=root\nExecStart=/usr/bin/python3 {CONTROLLER} excalidraw-host {action}\nTimeoutStartSec=60\nUMask=0077\n'
    units['larm-excalidraw-gateway.service'] = f'''[Unit]
Description=LARM Excalidraw request gateway
After=larm-daemon.service
[Service]
Type=simple
User={daemon_user}
Group={daemon_user}
WorkingDirectory={release}
Environment="LARM_HOSTED_GATEWAY_CONFIG={CONF}/gateway.json"
ExecStart={runtime} {release}/gateway.js
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
    for name, text in units.items():
        result[Path('/etc/systemd/system') / name] = text.encode()
    manifest = {'version': 1, 'serviceId': 'excalidraw-host', 'release': release_digest, 'user': APP_USER, 'endpoint': 'http://127.0.0.1:18791', 'storage': {'dataRoot': str(DATA), 'mountPoint': str(MOUNT), 'filesystemUuid': UUID, 'minFreeBytes': 2147483648}, 'writePaths': [str(DATA / x) for x in ['data', 'state', 'cache', 'work/app']], 'assetHashes': {str(p): digest(b) for p, b in result.items() if str(p).startswith('/opt/') or p == CONTROLLER}, 'unitHashes': {name: digest(text.encode()) for name, text in units.items() if name.startswith('larm-local-service-')}, 'members': [{'unit': member, 'memoryMaxBytes': 1024 ** 3, 'tasksMax': 256, 'cpuQuotaPercent': 200}], 'ports': [18791], 'lifecycleSecret': str(CONF / 'lifecycle-token'), 'staleAfterSeconds': 15, 'startSeconds': 45, 'stopSeconds': 45}
    manifest['manifestDigest'] = digest(canonical(manifest))
    result[Path('/etc/larm-local-services/process/excalidraw-host.json')] = canonical(manifest)
    definition = {'schemaVersion': 'larm.local-services.v2', 'services': {'excalidraw-host': {'node': 'local-node', 'backend': 'systemd-process', 'deployment': {'unit': 'larm-local-service-excalidraw.service', 'stopUnit': 'larm-local-service-excalidraw-stop.service', 'observeUnit': 'larm-local-service-excalidraw-observe.service', 'members': [member], 'release': release_digest, 'manifestDigest': manifest['manifestDigest'], 'endpoint': manifest['endpoint'], 'publicEndpoint': manifest['endpoint']}, 'readiness': {'timeoutSeconds': 45, 'path': '/health/ready', 'status': 'ready', 'capabilities': {'drawings': True, 'mcp': True}}, 'activity': {'secretRef': 'excalidraw-lifecycle', 'pollSeconds': 5, 'staleAfterSeconds': 15}, 'lifecycle': {'minInstances': 0, 'idleSeconds': 120, 'leaseSeconds': 120, 'gracefulStopSeconds': 45, 'restartPolicy': 'on-next-ensure'}, 'resources': {'startupReservationBytes': 1024 ** 3, 'cpuMaxCores': 2, 'maxInstances': 1, 'gpuAccess': False}, 'storage': manifest['storage']}}}
    result[CONF / 'services.yaml'] = canonical(definition)
    rule = f'''polkit.addRule(function(action, subject) {{
  if (action.id === "org.freedesktop.systemd1.manage-units" && subject.user === "{daemon_user}" && ((action.lookup("verb") === "start" && ["larm-local-service-excalidraw.service", "larm-local-service-excalidraw-stop.service", "larm-local-service-excalidraw-observe.service"].indexOf(action.lookup("unit")) !== -1) || (action.lookup("verb") === "stop" && action.lookup("unit") === "larm-local-service-excalidraw.service"))) return polkit.Result.YES;
}});
'''
    result[Path('/etc/polkit-1/rules.d/61-larm-excalidraw-control.rules')] = rule.encode()
    return result, release, runtime, manifest


def put(path, data, mode=0o644, gid=0):
    safe_path(path.parent)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    safe_path(path.parent)
    if path.exists():
        safe_path(path)
        if path.read_bytes() != data:
            raise RuntimeError('existing_file_changed')
        return
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    os.chown(path, 0, gid)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--bootstrap', action='store_true')
    parser.add_argument('--expected-digest')
    parser.add_argument('--daemon-user', default='ugnoguchi')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', args.daemon_user):
        raise RuntimeError('invalid_daemon_user')
    release_digest, files = prepared(args.expected_digest)
    result, release, runtime, manifest = artifacts(release_digest, files, args.daemon_user)
    if not args.apply:
        print(json.dumps({'mode': 'dry-run', 'digest': release_digest, 'files': len(result), 'dataRoot': str(DATA), 'database': str(DATA / 'state/documents.sqlite'), 'gateway': 'http://127.0.0.1:18790', 'activatesLarm': False, 'bootstrap': args.bootstrap}, indent=2))
        return
    if os.geteuid() != 0 or not args.expected_digest:
        raise RuntimeError('root_and_expected_digest_required')
    daemon = pwd.getpwnam(args.daemon_user)
    validate_request_path(Path('/var/lib/larm/local-services/requests'), daemon.pw_uid)
    # No writes to the mount before its exact identity is confirmed.
    mounted = json.loads(subprocess.check_output(['/usr/bin/findmnt', '--json', '--mountpoint', str(MOUNT), '--output', 'TARGET,UUID,FSTYPE,OPTIONS'], text=True))['filesystems']
    if len(mounted) != 1 or mounted[0]['uuid'] != UUID or mounted[0]['fstype'] != 'ext4' or 'rw' not in mounted[0]['options'].split(','):
        raise RuntimeError('required_storage_unavailable')
    safe_path(DATA.parent)
    space = os.statvfs(MOUNT)
    if space.f_bavail * space.f_frsize < 2147483648:
        raise RuntimeError('storage_capacity_low')
    if CONF.exists() or DATA.exists() or PRIVATE.exists():
        raise RuntimeError('initial_install_only_existing_deployment')
    for path, data in result.items():
        safe_path(path)
        if path.exists() and path.read_bytes() != data:
            raise RuntimeError('existing_file_changed')
    try:
        pwd.getpwnam(APP_USER)
        raise RuntimeError('app_user_already_exists')
    except KeyError:
        subprocess.run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir', str(PRIVATE / 'home'), '--shell', '/usr/sbin/nologin', APP_USER], check=True)
    app = pwd.getpwnam(APP_USER)
    for path in [DATA, *[DATA / x for x in ['state', 'data', 'cache', 'work', 'work/app']], PRIVATE, PRIVATE / 'home', PRIVATE / 'config']:
        safe_path(path.parent) if path in [DATA, PRIVATE] else None
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(path, app.pw_uid, app.pw_gid)
    for path, data in result.items():
        put(path, data, 0o755 if path in [runtime, CONTROLLER] else 0o644)
    lifecycle, owner, larm = [secrets.token_urlsafe(48) for _ in range(3)]
    CONF.mkdir(parents=True, exist_ok=True, mode=0o755)
    app_config = {**manifest['storage'], 'hostname': '127.0.0.1', 'port': 18791, 'webRoot': str(release / 'web'), 'lifecycleToken': lifecycle, 'clients': [{'owner': 'local-owner', 'token': owner}]}
    put(CONF / 'app.json', canonical(app_config), 0o640, app.pw_gid)
    put(CONF / 'lifecycle-token', lifecycle.encode(), 0o600)
    put(Path('/etc/larm/local-services/secrets/excalidraw-lifecycle'), lifecycle.encode(), 0o640, daemon.pw_gid)
    put(CONF / 'client-tokens.json', canonical([owner]), 0o640, daemon.pw_gid)
    put(CONF / 'larm-token', larm.encode(), 0o640, daemon.pw_gid)
    put(CONF / 'consumers.json', canonical([{'id': 'excalidraw-gateway', 'token': larm, 'services': ['excalidraw-host']}]), 0o640, daemon.pw_gid)
    put(CONF / 'gateway.json', canonical({'larmBaseUrl': 'http://127.0.0.1:9810', 'larmTokenFile': str(CONF / 'larm-token'), 'clientTokensFile': str(CONF / 'client-tokens.json'), 'gateway': {'hostname': '127.0.0.1', 'port': 18790, 'serviceId': 'excalidraw-host', 'webRoot': str(release / 'web'), 'allowedEndpoints': [manifest['endpoint']], 'userIdleSeconds': 180, 'renewSeconds': 15}}), 0o640, daemon.pw_gid)
    # Review-only fragment: application registration does not change the live inference daemon.
    dropin = f'[Service]\nEnvironment=LARM_LOCAL_SERVICES_ENABLED=true\nEnvironment=LARM_LOCAL_SERVICES_FILE={CONF}/services.yaml\nEnvironment=LARM_LOCAL_SERVICES_PRINCIPALS={CONF}/consumers.json\n'
    put(CONF / 'larm-daemon-dropin.review', dropin.encode())
    safe_path(Path('/var/lib/larm-local-services/observations'))
    requests = Path('/var/lib/larm/local-services/requests')
    validate_request_path(requests, daemon.pw_uid)
    Path('/var/lib/larm-local-services/observations').mkdir(parents=True, exist_ok=True, mode=0o755)
    Path('/var/lib/larm/local-services/requests').mkdir(parents=True, exist_ok=True, mode=0o700)
    validate_request_path(requests, daemon.pw_uid)
    fd = os.open(requests, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fchown(fd, daemon.pw_uid, daemon.pw_gid)
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)
    if args.bootstrap:
        subprocess.run(['/usr/sbin/runuser', '-u', APP_USER, '--', '/usr/bin/env', 'PATH=/usr/bin:/bin', f'EXCALIDRAW_HOST_CONFIG={CONF}/app.json', str(runtime), str(release / 'server.js'), '--bootstrap'], check=True)
    subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True)
    subprocess.run(['/usr/bin/python3', str(CONTROLLER), 'excalidraw-host', 'preflight'], check=True)
    print(json.dumps({'registered': True, 'bootstrapped': args.bootstrap, 'dataRoot': str(DATA), 'activation': 'review current LARM release, existing local-services configuration and dropin.review before restarting LARM and enabling gateway; app remains stopped', 'connectionKeyFile': str(CONF / 'client-tokens.json')}))


if __name__ == '__main__':
    main()
