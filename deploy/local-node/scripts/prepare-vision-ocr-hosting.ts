import { mkdir, cp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const app = "/srv/ai/apps/vision-ocr-host";
const stage = "/srv/ai/local-services-prepared/vision-ocr-production";
// Resolve a verified candidate environment built from the separate official checkouts.
const resolvePython = Bun.spawn(["python3", "-B", `${app}/scripts/upstream.py`, "runtime"], {
  cwd: app, stdout: "pipe", stderr: "inherit",
});
const python = (await new Response(resolvePython.stdout).text()).trim();
if (await resolvePython.exited !== 0 || !python.startsWith("/") || python.includes("\n")) throw new Error("verified_upstream_runtime_required");
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const check = Bun.spawn([python, "-m", "unittest", "discover", "-s", "tests", "-v"], {
  cwd: app, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdout: "inherit", stderr: "inherit",
});
if (await check.exited !== 0) throw new Error("application_check_failed");
// Preparation owns only these generated subdirectories; source, credentials and the venv remain intact.
await rm(`${stage}/release`, { recursive: true, force: true });
await rm(`${stage}/python`, { recursive: true, force: true });
await mkdir(`${stage}/release`, { recursive: true });
await cp(`${app}/vision_ocr`, `${stage}/release/vision_ocr`, { recursive: true, filter: path => !path.includes("__pycache__") });
await cp(`${stage}/models`, `${stage}/release/models`, { recursive: true });
await cp(`${app}/requirements.lock`, `${stage}/release/requirements.lock`);
await cp(`${app}/upstream.json`, `${stage}/release/upstream.json`);
const provenance = Bun.spawn(["python3", "-B", `${app}/scripts/upstream.py`, "provenance"], {
  cwd: app, stdout: "pipe", stderr: "inherit",
});
const sourceBuild = await new Response(provenance.stdout).text();
if (await provenance.exited !== 0) throw new Error("upstream_provenance_required");
await writeFile(`${stage}/release/upstream-build.json`, JSON.stringify(JSON.parse(sourceBuild), null, 2));
await mkdir(`${stage}/release/web`, { recursive: true });
const html = await readFile(`${app}/web/index.html`, "utf8");
for (const [mode, title] of [["ocr", "画像・動画の文字起こし"], ["objects", "画像・動画の物体認識"]]) {
  await mkdir(`${stage}/release/web/${mode}`, { recursive: true });
  await writeFile(`${stage}/release/web/${mode}/index.html`, html.replaceAll("__TITLE__", title));
}
const copyPython = Bun.spawn([python, "-c", `import sys,site,shutil
ignore=shutil.ignore_patterns('__pycache__','*.pyc')
shutil.copytree(sys.base_prefix, ${JSON.stringify(`${stage}/python`)}, symlinks=False, ignore=ignore)
shutil.copytree(site.getsitepackages()[0], ${JSON.stringify(`${stage}/release/site-packages`)}, symlinks=False, ignore=ignore)
`], { stdout: "inherit", stderr: "inherit" });
if (await copyPython.exited !== 0) throw new Error("python_freeze_failed");
await cp(process.execPath, `${stage}/bun`);
await cp("deploy/local-node/local-services/process-controller.py", `${stage}/process-controller.py`);
await cp("deploy/local-node/local-services/process-member.service.in", `${stage}/process-member.service.in`);
const build = await Bun.build({ entrypoints: ["deploy/local-node/scripts/hosted-service-gateway.ts"], outdir: stage, target: "bun", naming: "gateway.js" });
if (!build.success) throw new Error("gateway_build_failed");
const files: Record<string, { sha256: string; executable: boolean }> = {};
async function walk(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      const { stat } = await import("node:fs/promises");
      files[path.slice(stage.length + 1)] = { sha256: hash(await readFile(path)), executable: !!((await stat(path)).mode & 0o111) };
    } else throw new Error("stage_symlink_refused");
  }
}
await walk(`${stage}/release`);
await walk(`${stage}/python`);
for (const name of ["bun", "gateway.js", "process-controller.py", "process-member.service.in"]) {
  files[name] = { sha256: hash(await readFile(`${stage}/${name}`)), executable: ["bun", "process-controller.py"].includes(name) };
}
const digest = hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
await writeFile(`${stage}/prepared.json`, JSON.stringify({ version: 1, stage, appRepository: app, digest, files }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ prepared: `${stage}/prepared.json`, digest, fileCount: Object.keys(files).length }));
