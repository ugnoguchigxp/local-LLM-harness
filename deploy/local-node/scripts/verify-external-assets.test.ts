import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { parse, stringify } from "yaml";
import { inspectOpenedRegularFile } from "./external-asset-helpers";

const verifier = resolve(import.meta.dir, "verify-external-assets.ts");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture(options: { mismatch?: boolean; symlink?: boolean; assetUrl?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "larm-external-assets-"));
  temporaryRoots.push(root);
  const content = new TextEncoder().encode("fixture-vvm\n");
  const regularPath = join(root, "asset.bin");
  await writeFile(regularPath, content);
  const assetPath = join(root, "0.vvm");
  if (options.symlink) await symlink(regularPath, assetPath);
  else await writeFile(assetPath, content);
  const lockPath = join(root, "sources.lock.yaml");
  await writeFile(lockPath, stringify({
    sources: {
      "voicevox-vvm": {
        repository: "https://github.com/VOICEVOX/voicevox_vvm.git",
        version: "0.16.4",
        revision: "c7793d12c09e3ea0a4ae41ca2bbe8b91bb17ef61",
        path: assetPath,
        asset: {
          url: options.assetUrl ?? "https://github.com/VOICEVOX/voicevox_vvm/releases/download/0.16.4/0.vvm",
          bytes: content.byteLength,
          sha256: options.mismatch ? "0".repeat(64) : createHash("sha256").update(content).digest("hex"),
          terms: "https://github.com/VOICEVOX/voicevox_vvm/blob/0.16.4/README.md",
          acceptance: "operator-required",
        },
      },
    },
  }));
  return lockPath;
}

async function run(lockPath: string) {
  const process = Bun.spawn(["bun", "run", verifier, "--require-valid"], {
    env: {
      ...Bun.env,
      LARM_SOURCE_LOCK: lockPath,
      VOICEVOX_VVM_ROOT: resolve(lockPath, ".."),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  return {
    exitCode,
    result: JSON.parse(stdout) as {
      valid: boolean;
      assets: Array<{ valid: boolean; actual: { type: string }; required: boolean }>;
    },
  };
}

test("accepts a regular external asset with the pinned identity", async () => {
  const result = await run(await fixture());
  expect(result.exitCode).toBe(0);
  expect(result.result.valid).toBeTrue();
  expect(result.result.assets[0]?.actual.type).toBe("regular");
});

test("fails closed on checksum drift", async () => {
  const result = await run(await fixture({ mismatch: true }));
  expect(result.exitCode).toBe(1);
  expect(result.result.valid).toBeFalse();
});

test("rejects a symlinked external asset", async () => {
  const result = await run(await fixture({ symlink: true }));
  expect(result.exitCode).toBe(1);
  expect(result.result.assets[0]?.actual.type).toBe("symlink");
});

test("allows an optional VVM to remain unstaged", async () => {
  const lockPath = await fixture();
  const parsed = parse(await Bun.file(lockPath).text());
  parsed.sources["voicevox-vvm-masculine"] = {
    ...parsed.sources["voicevox-vvm"],
    path: resolve(lockPath, "../4.vvm"),
    required: false,
    asset: {
      ...parsed.sources["voicevox-vvm"].asset,
      url: "https://github.com/VOICEVOX/voicevox_vvm/releases/download/0.16.4/4.vvm",
    },
  };
  await writeFile(lockPath, stringify(parsed));
  const result = await run(lockPath);
  expect(result.exitCode).toBe(0);
  expect(result.result.assets[1]).toMatchObject({ valid: true, required: false, actual: { type: "missing" } });

  await writeFile(resolve(lockPath, "../4.vvm"), "wrong optional asset\n");
  const corrupt = await run(lockPath);
  expect(corrupt.exitCode).toBe(1);
  expect(corrupt.result.assets[1]).toMatchObject({ valid: false, required: false, actual: { type: "regular" } });
});

test("rejects an asset path replaced after its file descriptor is opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-external-asset-race-"));
  temporaryRoots.push(root);
  const assetPath = join(root, "0.vvm");
  const originalPath = join(root, "original.vvm");
  await writeFile(assetPath, "original\n");
  const handle = await open(assetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await rename(assetPath, originalPath);
    await writeFile(assetPath, "replacement\n");
    await expect(inspectOpenedRegularFile(assetPath, handle)).rejects.toThrow(
      "external asset changed while being inspected",
    );
  } finally {
    await handle.close();
  }
});

test("rejects an asset URL that is inconsistent with the pinned version", async () => {
  const lockPath = await fixture({
    assetUrl: "https://github.com/VOICEVOX/voicevox_vvm/releases/download/0.16.3/0.vvm",
  });
  const process = Bun.spawn(["bun", "run", verifier, "--require-valid"], {
    env: {
      ...Bun.env,
      LARM_SOURCE_LOCK: lockPath,
      VOICEVOX_VVM_ROOT: resolve(lockPath, ".."),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(await process.exited).not.toBe(0);
});
