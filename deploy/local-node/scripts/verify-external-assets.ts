import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ExternalAssetInspectionError, inspectRegularFile } from "./external-asset-helpers";

const sourceLockPath = resolve(
  process.env.LARM_SOURCE_LOCK ?? resolve(import.meta.dir, "../sources.lock.yaml"),
);
const vvmRoot = resolve(
  process.env.VOICEVOX_VVM_ROOT
    ?? (process.env.VOICEVOX_RUNTIME_ROOT
      ? resolve(process.env.VOICEVOX_RUNTIME_ROOT, "models/vvms")
      : "/srv/ai/apps/voicevox-core-0.17.0/runtime/models/vvms"),
);

const vvmSchema = z.object({
  repository: z.literal("https://github.com/VOICEVOX/voicevox_vvm.git"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.string().refine(isAbsolute, "path must be absolute"),
  required: z.boolean().default(true),
  asset: z.object({
    url: z.string().url(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    terms: z.string().url(),
    acceptance: z.literal("operator-required"),
  }).strict(),
}).strict().superRefine((value, context) => {
  const filename = basename(value.path);
  if (dirname(value.path) !== vvmRoot) {
    context.addIssue({ code: "custom", message: `VOICEVOX VVM path must be inside ${vvmRoot}` });
  }
  if (!/^\d+\.vvm$/.test(filename)) {
    context.addIssue({ code: "custom", message: "VOICEVOX VVM path must end in a numeric .vvm filename" });
  }
  const expectedUrl = `https://github.com/VOICEVOX/voicevox_vvm/releases/download/${value.version}/${filename}`;
  if (value.asset.url !== expectedUrl) {
    context.addIssue({ code: "custom", message: "VOICEVOX VVM asset URL must match the pinned version" });
  }
  const expectedTerms = `https://github.com/VOICEVOX/voicevox_vvm/blob/${value.version}/README.md`;
  if (value.asset.terms !== expectedTerms) {
    context.addIssue({ code: "custom", message: "VOICEVOX VVM terms must match the pinned version" });
  }
});

const document = z.object({ sources: z.record(z.string(), z.unknown()) }).passthrough()
  .parse(parse(await readFile(sourceLockPath, "utf8")));
const definitions = Object.entries(document.sources)
  .filter(([id]) => id === "voicevox-vvm" || id.startsWith("voicevox-vvm-"))
  .map(([id, value]) => ({ id, definition: vvmSchema.parse(value) }));
if (definitions.length === 0) throw new Error("sources.lock.yaml contains no VOICEVOX VVM assets");

const assets = await Promise.all(definitions.map(async ({ id, definition }) => {
  let actual: { type: string; bytes?: number; sha256?: string } = { type: "missing" };
  let identityValid = false;
  let error: string | undefined;
  try {
    const metadata = await lstat(definition.path);
    if (!metadata.isFile()) {
      actual = { type: metadata.isSymbolicLink() ? "symlink" : "other" };
      error = "external asset must be a regular file";
    } else {
      actual = { type: "regular", ...await inspectRegularFile(definition.path) };
      identityValid = actual.bytes === definition.asset.bytes
        && actual.sha256 === definition.asset.sha256;
      if (!identityValid) error = "external asset identity does not match sources.lock.yaml";
    }
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      error = "external asset is missing";
    } else if (code === "ELOOP") {
      actual = { type: "symlink" };
      error = "external asset must not become a symlink while being inspected";
    } else if (cause instanceof ExternalAssetInspectionError) {
      error = cause.message;
    } else {
      throw cause;
    }
  }
  const valid = identityValid || (!definition.required && actual.type === "missing");
  return {
    valid,
    identityValid,
    id,
    required: definition.required,
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
  };
}));
const valid = assets.every((asset) => asset.valid);
console.log(JSON.stringify({ valid, sourceLock: sourceLockPath, assets }));

if (process.argv.includes("--require-valid") && !valid) process.exit(1);
