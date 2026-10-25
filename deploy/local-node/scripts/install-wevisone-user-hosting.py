#!/usr/bin/env python3
"""Install a disabled, demand-started user unit using an already prepared GPU environment."""
import hashlib
import json
import os
import pwd
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if os.getuid() == 0:
    raise SystemExit("run as the LARM daemon account, not root")
repository = Path(__file__).resolve().parents[3]
application = repository / "apps/wevisone-vl"
python = Path(os.environ.get("WEVISONE_PYTHON", "/srv/ai/apps/wevisone-vl-eval-20261025/.venv/bin/python"))
source = Path(os.environ.get("WEVISONE_SOURCE", "/srv/ai/apps/wevisone-vl-source-20261025"))
model = Path(json.loads((application / "model-receipt.json").read_text())["directory"])
if not python.is_file() or not source.is_dir() or not model.is_dir():
    raise SystemExit("prepare the pinned external model, upstream source and ROCm Python environment first")
code = """import importlib.metadata as m,json;print(json.dumps({d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()}))"""
installed = json.loads(subprocess.check_output([str(python), "-c", code], text=True))
for line in (application / "requirements.lock").read_text().splitlines():
    if not line or line.startswith("#"):
        continue
    name, version = line.split("==")
    if installed.get(name.lower().replace("_", "-")) != version:
        raise SystemExit("Python dependency mismatch: " + name)
if subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() != "40f735b8daed437ece982db9718e9c9856f52a79":
    raise SystemExit("upstream revision mismatch")
if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True).strip():
    raise SystemExit("upstream source is dirty")
files = [p for p in sorted(application.iterdir()) if p.is_file() and not p.name.startswith("test_")]
digest = hashlib.sha256()
for path in files:
    digest.update(path.name.encode() + b"\0" + path.read_bytes())
target = Path("/srv/ai/apps/wevisone-vl-host") / digest.hexdigest()[:16]
target.parent.mkdir(parents=True, exist_ok=True)
if not target.exists():
    staging = Path(tempfile.mkdtemp(prefix=".preparing-", dir=target.parent))
    try:
        for path in files:
            shutil.copyfile(path, staging / path.name)
            (staging / path.name).chmod(0o444)
        staging.chmod(0o755)
        staging.rename(target)
    except Exception:
        shutil.rmtree(staging)
        raise
else:
    for path in files:
        if (target / path.name).read_bytes() != path.read_bytes():
            raise SystemExit("immutable worker source mismatch")
config = Path.home() / ".config/systemd/user"
config.mkdir(parents=True, exist_ok=True)
unit = f"""[Unit]
Description=WeVisOne-VL-4B on-demand BF16 visual perception

[Service]
Type=simple
WorkingDirectory={target}
ExecStart={python} -B {target}/server.py
Environment=WEVISONE_SOURCE={source}
Environment=WEVISONE_MODEL={model}
Environment=WEVISONE_PORT=8094
Environment=HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
Environment=MIOPEN_FIND_MODE=FAST TORCH_BLAS_PREFER_HIPBLASLT=1
Environment=OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=1 PYTHONDONTWRITEBYTECODE=1
Restart=no
TimeoutStopSec=10
KillMode=control-group
MemoryMax=32G
CPUQuota=400%
TasksMax=512
NoNewPrivileges=yes
UMask=0077
StandardOutput=journal
StandardError=journal
"""
unit_path = config / "wevisone-vl.service"
if subprocess.run(["systemctl", "--user", "is-active", "--quiet", "wevisone-vl.service"]).returncode == 0:
    raise SystemExit("release active WeVisOne connections before replacing its unit")
temporary = unit_path.with_suffix(".service.tmp")
temporary.write_text(unit)
temporary.chmod(0o644)
temporary.replace(unit_path)
subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
subprocess.run(["loginctl", "enable-linger", pwd.getpwuid(os.getuid()).pw_name], check=True)
print(json.dumps({"installed": True, "scope": "user", "service": "wevisone-vl.service", "enabled": False,
                  "workerSource": str(target), "python": str(python), "port": 8094}))
