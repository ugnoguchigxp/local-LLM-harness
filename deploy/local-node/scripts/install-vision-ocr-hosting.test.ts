import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseLocalServices } from "../../../packages/core/src/local-service";

test("vision/OCR registration uses separate cold workers and fixed protected units", () => {
  const path = resolve(import.meta.dir, "install-vision-ocr-hosting.py");
  const script = `import importlib.util,pathlib,json
s=importlib.util.spec_from_file_location('registration',${JSON.stringify(path)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
files={name:(b'fixture',False) for name in ['bun','gateway.js','process-controller.py','release/vision_ocr/server.py','python/bin/python3.12']}
files['process-member.service.in']=(pathlib.Path('deploy/local-node/local-services/process-member.service.in').read_bytes(),False)
a,release,python,bun,modes,manifests=m.artifacts('a'*64,files,'ugnoguchi')
assert len(modes)==len(manifests)==2
for mode in modes:
 manifest=manifests[mode['id']]
 assert manifest['ports']==[mode['port']]
 assert manifest['members'][0]['cpuQuotaPercent']==400
 unit=a[pathlib.Path('/etc/systemd/system')/manifest['members'][0]['unit']][0].decode()
 assert 'ProtectSystem=strict' in unit and 'MemorySwapMax=0' in unit
 assert 'PrivateDevices=yes' in unit and 'DevicePolicy=closed' in unit
 assert 'Restart=no' in unit and 'KillMode=control-group' in unit
 assert str(python) in unit and '@' not in unit
rule=a[pathlib.Path('/etc/polkit-1/rules.d/62-larm-vision-ocr-control.rules')][0].decode()
assert 'larm-daemon.service' not in rule
assert 'larm-local-service-ocr-host-app.service' not in rule
assert 'larm-local-service-object-recognition-host-app.service' not in rule
print(a[m.CONF/'services.yaml'][0].decode())
`;
  const result = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const definitions = parseLocalServices(JSON.parse(result.stdout.toString()), ["local-node"]);
  expect(definitions.map(d => d.id)).toEqual(["object-recognition-host", "ocr-host"]);
  for (const d of definitions) {
    expect(d.lifecycle.minInstances).toBe(0);
    expect(d.resources.gpuAccess).toBe(false);
    expect(d.deployment.publicEndpoint).toBe(d.deployment.endpoint);
    expect(d.resources.startupReservationBytes).toBe(2 * 1024 ** 3);
  }
});

test("synchronous daemon restart failure restores the original configuration before enabling gateways", () => {
  const path = resolve(import.meta.dir, "install-vision-ocr-hosting.py");
  const script = `import importlib.util,pathlib,tempfile,subprocess
from unittest.mock import patch
s=importlib.util.spec_from_file_location('registration',${JSON.stringify(path)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
calls=[]
def run(args,check):
 calls.append(args)
 if len(calls)==2: raise subprocess.CalledProcessError(1,args)
with tempfile.TemporaryDirectory() as t:
 p=pathlib.Path(t)/'added.conf';p.write_text('fixture')
 unrelated=pathlib.Path(t)/'existing.conf';unrelated.write_text('preserved')
 with patch.object(m.subprocess,'run',run):
  try: m.start_registered_gateways(p,['fixture-gateway.service']);raise AssertionError('accepted failed restart')
  except RuntimeError as e: assert str(e)=='activation_failed_original_daemon_configuration_restored'
 assert not p.exists() and unrelated.read_text()=='preserved'
 assert [a[1] for a in calls]==['daemon-reload','restart','daemon-reload','restart']
 assert not any('enable' in a for a in calls)
print('rollback passed')
`;
  const result = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toContain("rollback passed");
});
