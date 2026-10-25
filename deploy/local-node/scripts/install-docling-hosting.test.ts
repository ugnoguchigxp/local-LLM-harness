import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseLocalServices } from "../../../packages/core/src/local-service";

test("Docling registration preserves existing services and binds a dedicated CPU process", () => {
  const installer = resolve(import.meta.dir, "install-docling-hosting.py");
  const template = resolve(import.meta.dir, "../local-services/process-member.service.in");
  const result = Bun.spawnSync(["python3", "-c", `
import importlib.util,json,pathlib,tempfile
s=importlib.util.spec_from_file_location('installer',${JSON.stringify(installer)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
files={name:{'sha256':'b'*64,'executable':False} for name in ['release/docling_lifecycle.py','release/gateway.js','process-controller.py','process-member.service.in']}
v={'digest':'a'*64,'python':'/opt/fixed-python','bun':'/opt/fixed-bun','files':files,'externalAssets':{'/opt/fixed-python':'c'*64,'/opt/fixed-bun':'d'*64}}
release,units,manifest,definition=m.artifacts(v,pathlib.Path(${JSON.stringify(template)}).read_text(),'fixture')
assert manifest['manifestDigest']==m.digest(m.canonical({k:v for k,v in manifest.items() if k!='manifestDigest'}))
for name,h in manifest['unitHashes'].items(): assert m.digest(units[name].encode())==h
app=units['larm-local-service-docling-desk-app.service']
assert 'User=larm-docling' in app and '--workers 1' in app and '--host 127.0.0.1' in app
assert 'ReadWritePaths=/var/lib/larm-apps/docling-desk /srv/storage/nextorage/' in app
assert 'HF_HUB_OFFLINE=1' in app and 'PrivateDevices=yes' in app and 'Restart=no' in app
assert all('@' not in text for text in units.values())
assert definition['deployment']['publicEndpoint']==definition['deployment']['endpoint']
existing={'schemaVersion':'larm.local-services.v2','services':{'excalidraw-host':{'keep':'unchanged'}}}
merged=m.merge_services(existing,definition)
assert merged['services']['excalidraw-host']==existing['services']['excalidraw-host']
assert 'docling-desk' not in existing['services']
try: m.merge_services(merged,definition);raise AssertionError('duplicate accepted')
except RuntimeError as e: assert str(e)=='existing_service_conflict'
with tempfile.TemporaryDirectory() as t:
 p=pathlib.Path(t);(p/'release').mkdir();(p/'release/test').write_text('original')
 value={'version':1,'sourceRevision':'c'*40,'files':{'release/test':{'sha256':m.checksum(p/'release/test'),'executable':False}}}
 value['digest']=m.digest(m.canonical(value));(p/'prepared.json').write_text(json.dumps(value))
 (p/'release/test').write_text('changed')
 try: m.prepared(p,value['digest']);raise AssertionError('mutation accepted')
 except RuntimeError as e: assert str(e)=='prepared_asset_changed'
 (p/'release/test').unlink();(p/'release/test').symlink_to('/etc/passwd')
 try: m.prepared(p,value['digest']);raise AssertionError('symlink accepted')
 except RuntimeError as e: assert str(e)=='prepared_asset_changed'
 value={'version':1,'sourceRevision':'c'*40,'files':{'release/../../escape':{'sha256':'a'*64}}}
 value['digest']=m.digest(m.canonical(value));(p/'prepared.json').write_text(json.dumps(value))
 try: m.prepared(p,value['digest']);raise AssertionError('traversal accepted')
 except RuntimeError as e: assert str(e)=='invalid_prepared_path'
print(json.dumps({'schemaVersion':'larm.local-services.v2','services':{'docling-desk':definition}}))
`], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const definitions = parseLocalServices(JSON.parse(result.stdout.toString()), ["local-node"]);
  expect(definitions[0]?.resources.gpuAccess).toBe(false);
  expect(definitions[0]?.lifecycle.minInstances).toBe(0);
});
