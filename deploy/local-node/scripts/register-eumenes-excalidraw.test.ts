import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("dedicated credentials preserve existing rights and documents while separating API roles", () => {
  const path = resolve(import.meta.dir, "register-eumenes-excalidraw.py");
  const script = `import importlib.util,copy
s=importlib.util.spec_from_file_location('registration',${JSON.stringify(path)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
app={'lifecycleToken':'lifecycle-key','clients':[{'owner':'existing-owner','token':'old-business'}]}
active=[{'id':'legacy','token':'old-control','services':['ocr-host','excalidraw-host']}]
packaged=[{'id':'gateway','token':'gateway-control','services':['excalidraw-host']}]
credentials={'consumerToken':'c'*64,'apiToken':'a'*64,'owner':'existing-owner'}
inputs=copy.deepcopy([app,['old-business'],active,packaged])
result=m.build_registration(*inputs,credentials)
assert inputs==[app,['old-business'],active,packaged]
assert result[2][0]==active[0] and result[3][0]==packaged[0]
assert result[2][-1]['services']==['excalidraw-host']
assert result[0]['clients'][0]==app['clients'][0]
assert result[0]['clients'][-1]['owner']=='existing-owner'
assert credentials['consumerToken'] not in result[1]
assert all(p['token']!=credentials['apiToken'] for p in result[2]+result[3])
assert m.build_registration(*result,credentials)==result
for wrong in [{**credentials,'apiToken':credentials['consumerToken']},{**credentials,'owner':'replacement-owner'}]:
 try:m.build_registration(*inputs,wrong);raise AssertionError('accepted role or owner change')
 except RuntimeError:pass
conflict=active+[{'id':m.CONSUMER_ID,'token':'different','services':['ocr-host']}]
try:m.build_registration(app,['old-business'],conflict,packaged,credentials);raise AssertionError('overwrote existing consumer')
except RuntimeError as e:assert str(e)=='existing_consumer_conflict'
print('separated registration passed')
`;
  const result = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toContain("separated registration passed");
});
