import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { systemServiceAnonymousMemoryBytes } from "./service-memory";

test("media reservation credits only measured anonymous memory and preserves unknown usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-service-memory-"));
  const group = join(root, "system.slice", "image.service");
  try {
    await mkdir(group, { recursive: true });
    const path = join(group, "memory.stat");
    await writeFile(path, "anon 2048\nfile 10000000\nshmem 1024\n");
    expect(await systemServiceAnonymousMemoryBytes("image.service", root)).toBe(2048);
    for (const stat of ["file 2048\n", "anon -1\n", "anon 9999999999999999999999\n"]) {
      await writeFile(path, stat);
      expect(await systemServiceAnonymousMemoryBytes("image.service", root)).toBeUndefined();
    }
    expect(await systemServiceAnonymousMemoryBytes("missing.service", root)).toBeUndefined();
    expect(await systemServiceAnonymousMemoryBytes("../../image.service", root)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
