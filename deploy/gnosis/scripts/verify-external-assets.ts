import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
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
}).strict();

const documentSchema = z.object({
  sources: z.object({ "voicevox-vvm": vvmSchema }).passthrough(),
}).passthrough();

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
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
      bytes: metadata.size,
      sha256: await sha256(definition.path),
    };
    valid = actual.bytes === definition.asset.bytes && actual.sha256 === definition.asset.sha256;
    if (!valid) error = "external asset identity does not match sources.lock.yaml";
  }
} catch (cause) {
  if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  error = "external asset is missing";
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
