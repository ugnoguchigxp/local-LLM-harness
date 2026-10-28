#!/usr/bin/env python3
"""Install a separate, disabled demand-started user service without starting it."""
import hashlib, os, shutil, subprocess, tempfile
from pathlib import Path
if os.getuid() == 0:
    raise SystemExit('run as the LARM daemon user')
root = Path(__file__).resolve().parents[3]
app = root / 'apps/lfm3-vl-perception'
python = Path('/srv/ai/apps/vision-recognition-eval/.venv/bin/python')
engine = Path('/srv/ai/apps/larm-lfm3-vl-19cce69-v1/llama-server')
if not python.is_file() or not engine.is_file():
    raise SystemExit('prepare the LFM engine and Python with Pillow before installation')
subprocess.run([str(python), '-c', 'from PIL import Image,ImageOps'], check=True)
files = [app / n for n in ('server.py', 'handler.py', 'contract.py', 'imaging.py')]
digest = hashlib.sha256()
for file in files: digest.update(file.name.encode() + b'\0' + file.read_bytes())
parent = Path('/srv/ai/apps/larm-lfm3-vl-perception'); parent.mkdir(parents=True, exist_ok=True)
target = parent / digest.hexdigest()[:16]
if not target.exists():
    staging = Path(tempfile.mkdtemp(dir=parent, prefix='.preparing-'))
    try:
        for file in files:
            shutil.copyfile(file, staging / file.name); (staging / file.name).chmod(0o444)
        staging.chmod(0o755); staging.rename(target)
    except BaseException:
        shutil.rmtree(staging); raise
else:
    for file in files:
        if (target / file.name).read_bytes() != file.read_bytes(): raise SystemExit('snapshot mismatch')
unit = f'''[Unit]
Description=LFM3-VL CPU on-demand image description

[Service]
Type=simple
WorkingDirectory={target}
ExecStart={python} -B {target}/server.py
Environment=LFM_VISION_PORT=8095 PYTHONDONTWRITEBYTECODE=1
Restart=no
TimeoutStopSec=10
KillMode=control-group
MemoryMax=6G
CPUQuota=800%
TasksMax=128
NoNewPrivileges=yes
UMask=0077
'''
path = Path.home() / '.config/systemd/user/lfm3-vl-perception.service'
path.parent.mkdir(parents=True, exist_ok=True)
if subprocess.run(['systemctl', '--user', 'is-active', '--quiet', path.name]).returncode == 0:
    raise SystemExit('release active LFM vision connections before updating service')
tmp = path.with_suffix('.service.tmp'); tmp.write_text(unit); tmp.chmod(0o644); tmp.replace(path)
subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
print(f'Installed disabled service {path}; snapshot {target}')
