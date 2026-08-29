import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const sourceLockPath = resolve(
  process.env.LARM_SOURCE_LOCK ?? resolve(import.meta.dir, "../sources.lock.yaml"),
);

const vvmSchema = z.object({
  repository: z.literal("https://github.com/VOICEVOX/voicevox_vvm.git"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.string().refine(isAbsolute, "path must be absolute"),
  asset: z.object({
    url: z.string().url(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    terms: z.string().url(),
    acceptance: z.literal("operator-required"),
  }).strict(),
}).strict().superRefine((value, context) => {
  const expectedUrl = `https://github.com/VOICEVOX/voicevox_vvm/releases/download/${value.version}/0.vvm`;
  if (value.asset.url !== expectedUrl) {
    context.addIssue({ code: "custom", message: "VOICEVOX VVM asset URL must match the pinned version" });
  }
  const expectedTerms = `https://github.com/VOICEVOX/voicevox_vvm/blob/${value.version}/README.md`;
  if (value.asset.terms !== expectedTerms) {
    context.addIssue({ code: "custom", message: "VOICEVOX VVM terms must match the pinned version" });
  }
});

const documentSchema = z.object({
  sources: z.object({ "voicevox-vvm": vvmSchema }).passthrough(),
}).passthrough();

async function inspectRegularFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("external asset must be a regular file");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return { bytes: metadata.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

const parsed = documentSchema.parse(parse(await readFile(sourceLockPath, "utf8")));
const definition = parsed.sources["voicevox-vvm"];
let actual: { type: string; bytes?: number; sha256?: string } = { type: "missing" };
let valid = false;
let error: string | undefined;

try {
  const metadata = await lstat(definition.path);
  if (!metadata.isFile()) {
    actual = { type: metadata.isSymbolicLink() ? "symlink" : "other" };
    error = "external asset must be a regular file";
  } else {
    actual = {
      type: "regular",
      ...await inspectRegularFile(definition.path),
    };
    valid = actual.bytes === definition.asset.bytes && actual.sha256 === definition.asset.sha256;
    if (!valid) error = "external asset identity does not match sources.lock.yaml";
  }
} catch (cause) {
  const code = (cause as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    error = "external asset is missing";
  } else if (code === "ELOOP") {
    actual = { type: "symlink" };
    error = "external asset must not become a symlink while being inspected";
  } else {
    throw cause;
  }
}

console.log(JSON.stringify({
  valid,
  id: "voicevox-vvm-0",
  sourceLock: sourceLockPath,
  version: definition.version,
  revision: definition.revision,
  path: definition.path,
  expected: {
    bytes: definition.asset.bytes,
    sha256: definition.asset.sha256,
    acceptance: definition.asset.acceptance,
  },
  actual,
  ...(error ? { error } : {}),
}));

if (process.argv.includes("--require-valid") && !valid) process.exit(1);
