#!/usr/bin/env python3
"""Initial installation of the LAN OCR ingress; existing gateway/daemon are untouched."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import socket
import subprocess
import sys

UNIT = 'larm-ocr-host-ingress.service'
GATEWAY = 'larm-ocr-host-gateway.service'
CONFIG = Path('/etc/larm-local-services/ocr-ingress/config.json')
RECEIPT = CONFIG.with_name('installation.json')
UNIT_FILE = Path('/etc/systemd/system') / UNIT


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def private_network(routes, addresses):
    interfaces = {r['dev'] for r in routes if r.get('dst') == 'default' and r.get('dev')}
    if len(interfaces) != 1:
        raise RuntimeError('ambiguous_lan_interface')
    interface = next(iter(interfaces))
    matches = [a for a in addresses if a.get('ifname') == interface and a.get('operstate') in {'UP', 'UNKNOWN'}]
    ipv4 = [a for item in matches for a in item.get('addr_info', []) if a.get('family') == 'inet' and a.get('scope') == 'global']
    if len(ipv4) != 1:
        raise RuntimeError('ambiguous_lan_address')
    address = ipaddress.IPv4Address(ipv4[0]['local'])
    network = ipaddress.IPv4Network(f'{address}/{ipv4[0]["prefixlen"]}', strict=False)
    if not any(network.subnet_of(ipaddress.IPv4Network(n)) for n in ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']):
        raise RuntimeError('private_lan_required')
    return {'interface': interface, 'listenAddress': str(address), 'sourceCidr': str(network)}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unit_text(plan, release):
    return f'''[Unit]
Description=LARM authenticated OCR LAN ingress
After=network-online.target {GATEWAY}
Wants=network-online.target
Requires={GATEWAY}
PartOf={GATEWAY}
[Service]
Type=simple
User={plan['user']}
Group={plan['group']}
Environment="LARM_OCR_INGRESS_CONFIG={CONFIG}"
ExecStart={plan['bun']} {release}/ingress.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET
MemoryMax=268435456
TasksMax=64
UMask=0077
[Install]
WantedBy=multi-user.target {GATEWAY}
'''


def make_plan(bundle, port=None):
    if CONFIG.exists() or RECEIPT.exists() or UNIT_FILE.exists():
        raise RuntimeError('ocr_ingress_already_installed')
    if run('systemctl', 'is-active', GATEWAY) != 'active':
        raise RuntimeError('running_ocr_gateway_required')
    environment = shlex.split(run('systemctl', 'show', GATEWAY, '-p', 'Environment', '--value'))
    files = [e.split('=', 1)[1] for e in environment if e.startswith('LARM_HOSTED_GATEWAY_CONFIG=')]
    if len(files) != 1 or not files[0].startswith('/'):
        raise RuntimeError('registered_gateway_config_required')
    gateway_file = Path(files[0])
    gateway_bytes = gateway_file.read_bytes()
    gateway = json.loads(gateway_bytes).get('gateway', {})
    if gateway.get('serviceId') != 'ocr-host' or gateway.get('hostname') != '127.0.0.1' or type(gateway.get('port')) is not int or not 0 < gateway['port'] < 65536:
        raise RuntimeError('registered_ocr_gateway_required')
    network = private_network(json.loads(run('ip', '-4', '-json', 'route', 'show', 'default')), json.loads(run('ip', '-4', '-json', 'address', 'show')))
    # Reuse only the current port allocation on the distinct LAN address. The
    # upstream is always discovered from the service's configuration file.
    port = gateway['port'] if port is None else port
    if type(port) is not int or not 1024 <= port <= 65535:
        raise RuntimeError('invalid_ingress_port')
    with socket.socket() as listener:
        listener.bind((network['listenAddress'], port))
    firewall = run('/usr/sbin/ufw', 'status')
    if not firewall.startswith('Status: active\n'):
        raise RuntimeError('active_firewall_required')
    # Refuse a preexisting rule on the newly allocated public port. This makes
    # ownership and rollback of the single added rule unambiguous.
    if re.search(rf'(?m)^\s*{port}(?:/tcp)?\s', firewall):
        raise RuntimeError('ingress_port_has_existing_firewall_rule')
    user = run('systemctl', 'show', GATEWAY, '-p', 'User', '--value')
    account = pwd.getpwnam(user)
    if account.pw_uid == 0 or not re.fullmatch(r'[a-z_][a-z0-9_-]*', user):
        raise RuntimeError('unprivileged_gateway_user_required')
    import grp
    group = grp.getgrgid(account.pw_gid).gr_name
    pid = int(run('systemctl', 'show', GATEWAY, '-p', 'MainPID', '--value'))
    bun = Path(f'/proc/{pid}/exe').resolve(strict=True)
    if not str(bun).startswith('/opt/larm-local-services/runtimes/') or bun.stat().st_uid != 0 or bun.stat().st_mode & 0o022:
        raise RuntimeError('protected_bun_runtime_required')
    payload = {'schemaVersion': 1, 'serviceId': 'ocr-host', **network, 'port': port,
               'origin': f'http://{network["listenAddress"]}:{port}', 'gatewayConfigFile': str(gateway_file),
               'gatewayConfigSha256': sha(gateway_bytes), 'bundleSha256': sha(bundle.read_bytes()),
               'firewallSha256': sha(firewall.encode()), 'user': user, 'group': group, 'bun': str(bun)}
    return {**payload, 'confirmation': sha(canonical(payload))}


def apply(plan, bundle):
    if os.geteuid() != 0:
        raise RuntimeError('apply_requires_root')
    release = Path('/opt/larm-local-services/releases/ocr-ingress') / plan['bundleSha256']
    firewall_rule = ['from', plan['sourceCidr'], 'to', plan['listenAddress'], 'port', str(plan['port']), 'proto', 'tcp']
    added = False
    try:
        release.mkdir(parents=True, mode=0o755, exist_ok=True)
        target = release / 'ingress.js'
        if target.exists() and sha(target.read_bytes()) != plan['bundleSha256']:
            raise RuntimeError('ingress_release_conflict')
        target.write_bytes(bundle.read_bytes())
        target.chmod(0o644)
        CONFIG.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
        CONFIG.write_bytes(canonical({k: plan[k] for k in ['serviceId', 'listenAddress', 'port', 'gatewayConfigFile']}))
        CONFIG.chmod(0o644)
        UNIT_FILE.write_text(unit_text(plan, release))
        UNIT_FILE.chmod(0o644)
        subprocess.run(['systemd-analyze', 'verify', str(UNIT_FILE)], check=True)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'start', UNIT], check=True)
        # An unauthorized status check must reach the existing gateway, while
        # leaving the worker stopped. Readiness never sends analyze or ensure.
        import time
        import urllib.request
        import urllib.error
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for attempt in range(30):
            try:
                with opener.open(plan['origin'] + '/hosting/status', timeout=2):
                    raise RuntimeError('ingress_unexpectedly_unauthenticated')
            except urllib.error.HTTPError as error:
                if error.code == 401:
                    break
                raise RuntimeError('ingress_readiness_failed') from None
            except urllib.error.URLError:
                if attempt == 29:
                    raise RuntimeError('ingress_readiness_timed_out') from None
                time.sleep(0.1)
        subprocess.run(['/usr/sbin/ufw', 'allow', *firewall_rule, 'comment', 'LARM ocr-host ingress'], check=True)
        added = True
        subprocess.run(['systemctl', 'enable', UNIT], check=True)
        RECEIPT.write_bytes(canonical({**plan, 'firewallRule': firewall_rule, 'release': str(release)}))
        RECEIPT.chmod(0o644)
    except Exception:
        subprocess.run(['systemctl', 'disable', '--now', UNIT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if added:
            subprocess.run(['/usr/sbin/ufw', '--force', 'delete', 'allow', *firewall_rule], check=True)
        UNIT_FILE.unlink(missing_ok=True)
        CONFIG.unlink(missing_ok=True)
        RECEIPT.unlink(missing_ok=True)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--port', type=int)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--expected-digest')
    args = parser.parse_args()
    if args.apply:
        import fcntl
        lock = open('/run/lock/larm-ocr-ingress.lock', 'a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # Capture the exact reviewed bytes so a concurrent build cannot replace
    # the payload after its digest has been checked.
    import tempfile
    with tempfile.TemporaryDirectory(prefix='larm-ocr-ingress-') as temporary:
        bundle = Path(temporary) / 'ingress.js'
        shutil.copyfile(args.bundle, bundle)
        plan = make_plan(bundle, args.port)
        if args.apply:
            if args.expected_digest != plan['confirmation']:
                raise RuntimeError('reviewed_ingress_digest_required')
            apply(plan, bundle)
        print(json.dumps({**plan, 'applied': args.apply}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        reason = str(error)
        print(reason if re.fullmatch(r'[a-z_]{1,96}', reason) else 'ocr_ingress_install_failed', file=sys.stderr)
        raise SystemExit(1)
