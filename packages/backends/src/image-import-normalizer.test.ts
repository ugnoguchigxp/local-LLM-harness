import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonImageNormalizer } from "./image-import-normalizer";
const python = process.env.LARM_IMAGE_IMPORT_TEST_PYTHON ?? "/srv/ai/apps/qwen-image-2.1-runtime/.venv/bin/python";
const integration = test.skipIf(!existsSync(python));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(format: string, width = 32, height = 24, alpha = false, orientation = 1, animated = false) {
  const script = `from PIL import Image\nimport sys,io\na=Image.new('${alpha ? "RGBA" : "RGB"}',(${width},${height}),${alpha ? "(10,100,200,90)" : "(10,100,200)"})\nb=io.BytesIO(); exif=Image.Exif(); exif[274]=${orientation}; exif[270]='private GPS location and comment'\na.save(b,format='${format}',exif=exif,${format === "WEBP" ? "quality=75," : ""}${animated ? "save_all=True,append_images=[Image.new('RGB',a.size,(250,10,40))],duration=100,loop=0," : ""})\nsys.stdout.buffer.write(b.getvalue())`;
  const p = Bun.spawn([python, "-I", "-c", script], { stdout: "pipe", stderr: "pipe" }); const data = Buffer.from(await new Response(p.stdout).arrayBuffer());
  if (await p.exited) throw Error(await new Response(p.stderr).text()); return data;
}
async function output() { const root = await mkdtemp(join(tmpdir(), "larm-image-decode-")); roots.push(root); return join(root, "output"); }
async function inspect(path: string) {
  const p = Bun.spawn([python, "-I", "-c", "from PIL import Image; import sys,json; i=Image.open(sys.argv[1]); i.load(); print(json.dumps({'size':list(i.size),'mode':i.mode,'exif':dict(i.getexif()),'info':list(i.info)}))", path], { stdout: "pipe" });
  const value = await new Response(p.stdout).json() as { size: number[]; mode: string; exif: object; info: string[] }; expect(await p.exited).toBe(0); return value;
}
function payloads(data: Buffer) {
  const chunks: Buffer[] = []; for (let i = 12; i < data.length;) { const tag = data.toString("ascii", i, i + 4), size = data.readUInt32LE(i + 4); if (["VP8 ", "VP8L", "ALPH"].includes(tag)) chunks.push(data.subarray(i, i + 8 + size)); i += 8 + size + (size & 1); } return chunks;
}
integration("JPEG EXIF orientation is applied, PNG alpha preserved and all metadata removed", async () => {
  const normalize = pythonImageNormalizer(python), jpeg = await output(), png = await output();
  expect(await normalize(await fixture("JPEG", 32, 24, false, 6), "image/jpeg", jpeg)).toMatchObject({ width: 24, height: 32, hasAlpha: false, format: "png" });
  const decoded = await inspect(jpeg); expect(decoded.size).toEqual([24, 32]); expect(decoded.exif).toEqual({}); expect(decoded.info).toEqual([]);
  expect(await normalize(await fixture("PNG", 32, 24, true), "image/png", png)).toMatchObject({ width: 32, height: 24, hasAlpha: true, format: "png" });
  expect((await inspect(png)).mode).toBe("RGBA"); expect((await inspect(png)).info).toEqual([]);
});
integration("WebP preserves compressed pixels and alpha, stripping EXIF without a second lossy compression", async () => {
  const data = await fixture("WEBP", 32, 24, true), path = await output();
  expect(await pythonImageNormalizer(python)(data, "image/webp", path)).toMatchObject({ width: 32, height: 24, hasAlpha: true, format: "webp" });
  const saved = await readFile(path); expect(payloads(saved)).toEqual(payloads(data)); expect(saved.length).toBeLessThan(data.length);
  expect(saved.includes(Buffer.from("private GPS"))).toBe(false); expect((await inspect(path)).exif).toEqual({});
  const again = await output(); await pythonImageNormalizer(python)(saved, "image/webp", again); expect(await readFile(again)).toEqual(saved);
});
integration("2000x2000 accepted, either 2001px edge rejected without resizing", async () => {
  const normalize = pythonImageNormalizer(python);
  expect(await normalize(await fixture("PNG", 2000, 2000), "image/png", await output())).toMatchObject({ width: 2000, height: 2000 });
  for (const [width, height] of [[2001, 1], [1, 2001], [2001, 2001]]) await expect(normalize(await fixture("PNG", width, height), "image/png", await output())).rejects.toMatchObject({ code: "image_dimensions_exceeded", status: 413 });
});
integration("fake MIME, corruption, animation, rotated WebP and unsupported image formats rejected", async () => {
  const normalize = pythonImageNormalizer(python);
  const png = await fixture("PNG");
  await expect(normalize(png, "image/jpeg", await output())).rejects.toMatchObject({ code: "image_mime_mismatch", status: 415 });
  await expect(normalize(png.subarray(0, 60), "image/png", await output())).rejects.toMatchObject({ code: "invalid_image", status: 400 });
  await expect(normalize(Buffer.from("<svg/>"), "image/png", await output())).rejects.toMatchObject({ status: 400 });
  await expect(normalize(await fixture("WEBP", 32, 24, false, 6), "image/webp", await output())).rejects.toMatchObject({ code: "webp_orientation_unsupported", status: 415 });
  await expect(normalize(await fixture("WEBP", 32, 24, false, 1, true), "image/webp", await output())).rejects.toMatchObject({ code: "animated_image_unsupported", status: 415 });
  await expect(normalize(await fixture("GIF"), "image/png", await output())).rejects.toMatchObject({ code: "unsupported_image_format", status: 415 });
  await expect(normalize(new Uint8Array(16 * 1024 ** 2 + 1), "image/png", await output())).rejects.toMatchObject({ status: 413 });
});
test("missing decoder is unavailable without exposing environment or filenames", async () => {
  await expect(pythonImageNormalizer("/missing/python")(new Uint8Array([1]), "image/png", await output())).rejects.toMatchObject({ code: "image_decoder_unavailable", status: 503 });
});
