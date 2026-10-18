import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
const python = process.env.LARM_IMAGE_IMPORT_TEST_PYTHON ?? "/srv/ai/apps/qwen-image-2.1-runtime/.venv/bin/python";
test.skipIf(!existsSync(python))("native mesh input expands WebP losslessly only in private work, leaving saved source bytes intact", async () => {
  const script = String.raw`
import importlib.util,sys,tempfile
from pathlib import Path
from PIL import Image
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1]); module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)
    for alpha in (False,True):
        work=root/str(alpha);work.mkdir()
        image=Image.new('RGBA' if alpha else 'RGB',(64,48),(10,100,210,90) if alpha else (10,100,210))
        source=work/'source.image';image.save(source,format='WEBP',quality=75);before=source.read_bytes()
        module.validate_image(source)
        native=module.native_source(source,work)
        assert native.name=='native-source.png' and native.parent==work
        with Image.open(source) as original, Image.open(native) as decoded:
            original.load();decoded.load()
            assert decoded.format=='PNG' and original.mode==decoded.mode and original.tobytes()==decoded.tobytes()
            assert not decoded.info
        assert source.read_bytes()==before
    png=root/'source.png';Image.new('RGB',(32,32)).save(png)
    assert module.native_source(png,root)==png
print('passed')
`;
  const path = new URL("../../../deploy/local-node/providers/trellis2-provider.py", import.meta.url).pathname;
  const child = Bun.spawn([python, "-I", "-c", script, path], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text();
  expect(stderr).toBe(""); expect(await child.exited).toBe(0); expect(stdout.trim()).toBe("passed");
});
