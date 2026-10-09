import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { parseLocalServices } from "../../../packages/core/src/local-service";
test("Excalidraw registration binds files, storage, units, and least-privilege controls", () => {
  const path = resolve(import.meta.dir, "install-excalidraw-hosting.py");
  const script = `import importlib.util, hashlib, json, tempfile, pathlib
s=importlib.util.spec_from_file_location('installer', ${JSON.stringify(path)})
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
files={'bun':b'fixed-runtime','gateway.js':b'gateway','process-controller.py':b'controller','process-member.service.in':b'User=@APP_USER@\\nExecStart=@REGISTERED_EXEC_START@\\n','release/server.js':b'server','release/web/index.html':b'ui'}
a,r,b,manifest=m.artifacts('a'*64,files,'fixture')
assert manifest['manifestDigest']==m.digest(m.canonical({k:v for k,v in manifest.items() if k!='manifestDigest'}))
for name,h in manifest['unitHashes'].items(): assert m.digest(a[pathlib.Path('/etc/systemd/system')/name])==h
assert manifest['storage']['dataRoot'].startswith('/srv/storage/nextorage/')
assert all(p.startswith(manifest['storage']['dataRoot']+'/') for p in manifest['writePaths'])
assert str(m.CONTROLLER) in manifest['assetHashes']
rule=a[pathlib.Path('/etc/polkit-1/rules.d/61-larm-excalidraw-control.rules')].decode()
assert 'action.lookup("verb") === "stop"' in rule
assert 'larm-local-service-excalidraw-app.service' not in rule
assert not any('larm-daemon.service.d' in str(p) for p in a)
with tempfile.TemporaryDirectory() as t:
 m.STAGE=pathlib.Path(t)
 for name,data in files.items():
  p=m.STAGE/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(data)
 hashes={k:m.digest(v) for k,v in files.items()}
 expected=m.digest(json.dumps(sorted(hashes.items()),separators=(',',':'),ensure_ascii=False).encode())
 (m.STAGE/'prepared.json').write_text(json.dumps({'version':1,'stage':t,'files':hashes,'digest':expected}))
 assert m.prepared(expected)[0]==expected
 (m.STAGE/'bun').write_bytes(b'changed')
 try: m.prepared(expected); raise AssertionError('accepted changed runtime')
 except RuntimeError as e: assert str(e)=='prepared_file_changed'
 (m.STAGE/'bun').unlink(); (m.STAGE/'bun').symlink_to('/usr/bin/true')
 try: m.prepared(expected); raise AssertionError('accepted symlink')
 except RuntimeError as e: assert str(e)=='prepared_path_changed'
m.validate_request_path(pathlib.Path('/var/lib/__larm-fixture-absent__/requests'), __import__('os').getuid())
with tempfile.TemporaryDirectory() as t:
 p=pathlib.Path(t)/'requests'; p.symlink_to('/var/lib/larm')
 try: m.validate_request_path(p, __import__('os').getuid()); raise AssertionError('accepted redirected request root')
 except RuntimeError as e: assert str(e)=='request_root_changed'
print('registration contract passed')
print(a[m.CONF/'services.yaml'].decode())
`;
  const result = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toContain("registration contract passed");
  const definitions = parseLocalServices(JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!), ["local-node"]);
  expect(definitions[0].deployment.publicEndpoint).toBe(definitions[0].deployment.endpoint);
  expect(definitions[0].lifecycle.minInstances).toBe(0);
});
