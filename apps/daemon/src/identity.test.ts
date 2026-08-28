import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeConfigRevision, createBootEpoch } from "./identity";

test("boot epochs are header-safe and reject weak sources", () => {
  expect(createBootEpoch(() => "12345678-AB_cd!")).toBe("epoch-12345678-ABcd");
  expect(() => createBootEpoch(() => "short")).toThrow(/at least 8/);
});

test("config revision covers every registry file and the artifact manifest", async () => {
  const root = await Bun.$`mktemp -d`.text().then((value) => value.trim());
  const config = join(root, "config");
  const manifest = join(root, "models.yaml");
  const relocatedConfig = join(root, "relocated", "config");
  const relocatedManifest = join(root, "relocated", "manifest.yaml");
  try {
    await mkdir(config);
    await mkdir(relocatedConfig, { recursive: true });
    for (const file of ["nodes.yaml", "runtimes.yaml", "profiles.yaml", "routes.yaml"]) {
      await writeFile(join(config, file), `${file}: original\n`);
      await writeFile(join(relocatedConfig, file), `${file}: original\n`);
    }
    await writeFile(manifest, "models: {}\n");
    await writeFile(relocatedManifest, "models: {}\n");
    const before = computeConfigRevision(config, manifest);
    expect(computeConfigRevision(relocatedConfig, relocatedManifest)).toBe(before);
    await writeFile(join(config, "routes.yaml"), "routes: changed\n");
    expect(computeConfigRevision(config, manifest)).not.toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
