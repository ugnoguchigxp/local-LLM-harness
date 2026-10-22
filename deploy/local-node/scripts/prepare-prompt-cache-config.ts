import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, dirname, resolve } from "node:path";
import { parseDocument } from "yaml";

/** Produce a candidate only. The active catalog/configuration is never written here. */
export function promptCacheCandidate(yaml: string, engine: string): string {
  if (!isAbsolute(engine) || !/^\/[a-zA-Z0-9_./-]+$/.test(engine)) throw new Error("unsupported engine path");
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw new Error("invalid provider configuration");
  const path = ["models", "ornith15-strix-conversation", "cmd"];
  const cmd = doc.getIn(path);
  if (typeof cmd !== "string") throw new Error("STRIX runtime is missing");
  const args = cmd.trim().split(/\s+/);
  // This pinned command uses unquoted arguments. Reject shell syntax instead of
  // interpreting it, and never accept flag prefixes or conflicting aliases.
  if (args.some(arg => !/^[a-zA-Z0-9_./:{}$=-]+$/.test(arg))) throw new Error("unsupported runtime command");
  const requireArg = (aliases: string[], expected: string, takesValue = false) => {
    const indexes = args.flatMap((arg, i) => aliases.some(alias => arg === alias || arg.startsWith(`${alias}=`)) ? [i] : []);
    if (indexes.length !== 1 || args[indexes[0]!] !== aliases[0] || (takesValue && args[indexes[0]! + 1] !== expected)) throw new Error("unexpected runtime baseline");
    return indexes[0]!;
  };
  const cache = requireArg(["--no-cache-prompt", "--cache-prompt"], "");
  const checkpoints = requireArg(["-ctxcp", "--ctx-checkpoints", "--swa-checkpoints"], "0", true);
  for (const [aliases, value] of [
    [["-cram", "--cache-ram"], "0"], [["--parallel", "-np"], "4"],
    [["--ctx-size", "-c"], "1048576"], [["--spec-type"], "none"], [["--cache-reuse"], "0"],
  ] as const) requireArg([...aliases], value, true);
  requireArg(["--no-cache-idle-slots", "--cache-idle-slots"], "");
  if (args.some(arg => ["-cpent", "--checkpoint-every-n-tokens"].some(alias => arg === alias || arg.startsWith(`${alias}=`)))) {
    throw new Error("unexpected checkpoint interval override");
  }
  args[0] = engine;
  args[cache] = "--cache-prompt";
  args[checkpoints + 1] = "8";
  args.push("-cpent", "1024");
  doc.setIn(path, args.join(" ") + "\n");
  return String(doc);
}

if (import.meta.main) {
  const [input, engine, output] = process.argv.slice(2);
  if (!input || !engine || !output || !isAbsolute(output)) throw new Error("usage: prepare-prompt-cache-config.ts INPUT ENGINE ABSOLUTE_CANDIDATE_OUTPUT");
  const repo = resolve(import.meta.dir, "../../..");
  const parent = realpathSync(dirname(output));
  if (parent === repo || parent.startsWith(`${repo}/`) || parent.startsWith("/var/lib/larm") || parent === "/etc" || parent.startsWith("/etc/")) throw new Error("output must be a staging directory outside the repository and active configuration");
  const manifest = JSON.parse(readFileSync(resolve(dirname(engine), "build-manifest.json"), "utf8"));
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const patch = resolve(import.meta.dir, "../patches/llama-prompt-cache-exact-prefix-v1.patch");
  if (manifest.baselineReproduced !== true || hash(engine) !== manifest.executableSha256 || hash(patch) !== manifest.promptCachePatchSha256) throw new Error("candidate build was not reproduced or digest mismatched");
  writeFileSync(output, promptCacheCandidate(readFileSync(input, "utf8"), engine), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ candidate: resolve(output), activated: false }));
}
