import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseDocument } from "yaml";
import { promptRetentionPolicySchema, promptRetentionMemoryGB } from "../../../packages/core/src/prompt-retention";

/** A candidate document only; never write the active catalog or stop/start a process. */
export function retentionCommand(command: string, engine: string, launcher: string, envFile: string, bytes: number): string {
  if (![engine, launcher, envFile].every(p => isAbsolute(p) && /^\/[a-zA-Z0-9_./-]+$/.test(p))) throw new Error("unsupported private path");
  const args = command.trim().split(/\s+/);
  if (args.some(arg => !/^[a-zA-Z0-9_./:{}$=-]+$/.test(arg))) throw new Error("unsupported engine command");
  const positions = args.flatMap((a, i) => ["-cram", "--cache-ram"].includes(a) ? [i] : []);
  if (positions.length !== 1 || args[positions[0]! + 1] !== "0" || bytes % 1024 ** 2 !== 0) throw new Error("unexpected RAM baseline");
  if (!args.includes("--cache-prompt") || !args.includes("--no-cache-idle-slots")) throw new Error("exact-prefix baseline required");
  if (args.some(a => a.startsWith("--cache-disk") || a.startsWith("--sleep-idle-seconds"))) throw new Error("unsupported disk/sleep configuration");
  const kvFlags = args.flatMap((a, i) => ["--kv-unified", "-kvu", "--no-kv-unified", "-no-kvu"].includes(a) ? [i] : []);
  if (kvFlags.length > 1) throw new Error("ambiguous KV layout");
  // Keep the total context and parallelism; give each execution sequence its
  // own equally sized KV stream. Connection retention is managed separately.
  if (kvFlags.length) args[kvFlags[0]!] = "--no-kv-unified";
  else args.push("--no-kv-unified");
  args[positions[0]! + 1] = String(bytes / 1024 ** 2);
  return ["/usr/bin/python3", launcher, envFile, engine, ...args.slice(1)].join(" ") + "\n";
}

if (import.meta.main) {
  const [configDir, runtimeId, engine, output] = process.argv.slice(2);
  if (!configDir || !runtimeId || !engine || !output || !isAbsolute(output)) throw new Error("usage: prepare-prompt-retention-config.ts CONFIG RUNTIME ENGINE NEW_CANDIDATE_DIR");
  const repo = resolve(import.meta.dir, "../../..");
  const parent = realpathSync(dirname(output));
  if (parent === repo || parent.startsWith(`${repo}/`) || parent === "/etc" || parent.startsWith("/etc/") || parent.startsWith("/var/lib/larm")) throw new Error("candidate must be outside source and active configuration");
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const manifest = JSON.parse(readFileSync(resolve(dirname(engine), "build-manifest.json"), "utf8"));
  if (manifest.protocol !== "larm-prompt-cache.v1" || !manifest.baselineReproduced || !manifest.nativeTestsPassed
    || hash(engine) !== manifest.executableSha256
    || hash(resolve(import.meta.dir, "../patches/llama-prompt-retention-v1.patch")) !== manifest.patchSha256
    || hash(resolve(import.meta.dir, "../patches/larm-prompt-retention.h")) !== manifest.headerSha256) throw new Error("unverified engine candidate");
  const runtimes = parseDocument(readFileSync(resolve(configDir, "runtimes.yaml"), "utf8"));
  const providers = parseDocument(readFileSync(resolve(configDir, "llama-swap.yaml"), "utf8"));
  if (runtimes.errors.length || providers.errors.length || runtimes.getIn(["runtimes", runtimeId, "backend"]) !== "llama-swap"
    || runtimes.getIn(["runtimes", runtimeId, "promptRetention"]) !== undefined) throw new Error("unsupported runtime baseline");
  // Select the engine model from the resolved runtime, never from a model/profile-name branch.
  const modelId = runtimes.getIn(["runtimes", runtimeId, "deployment", "modelId"]);
  if (typeof modelId !== "string") throw new Error("missing backend model binding");
  const command = providers.getIn(["models", modelId, "cmd"]);
  if (typeof command !== "string") throw new Error("missing runtime command");
  const policy = promptRetentionPolicySchema.parse({});
  const privateEnv = resolve(output, "prompt-retention.env.json");
  const launcher = resolve(output, "launch-prompt-retention.py");
  providers.setIn(["models", modelId, "cmd"], retentionCommand(command, engine, launcher, privateEnv, policy.maxBytes));
  runtimes.setIn(["runtimes", runtimeId, "promptRetention"], policy);
  mkdirSync(output, { mode: 0o700 });
  copyFileSync(resolve(import.meta.dir, "launch-prompt-retention.py"), launcher);
  writeFileSync(privateEnv, JSON.stringify({ LARM_PROMPT_CACHE_KEY: randomBytes(32).toString("hex"), LARM_PROMPT_CACHE_POLICY: JSON.stringify(policy) }), { flag: "wx", mode: 0o600 });
  writeFileSync(resolve(output, "runtimes.yaml"), String(runtimes), { flag: "wx", mode: 0o600 });
  writeFileSync(resolve(output, "llama-swap.yaml"), String(providers), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ candidate: resolve(output), activated: false, runtime: runtimeId, additionalMemoryGiB: promptRetentionMemoryGB(policy) }));
}
