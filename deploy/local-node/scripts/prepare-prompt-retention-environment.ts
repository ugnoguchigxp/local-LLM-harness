import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, chownSync } from "node:fs";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse } from "yaml";
import { loadRegistry } from "../../../packages/core/src/registry";

function readRegular(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error("unsafe retention input file");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** Generate engine credentials from the daemon's key, never from argv or stdout. */
export function preparePromptRetentionEnvironment(input: {
  configDir: string; credentialPath: string; outputPath: string; uid: number; gid: number;
}) {
  const swap = parse(readFileSync(join(input.configDir, "llama-swap.yaml"), "utf8"));
  // Dedicated runtime environments have independent policies. Only the commands
  // using this shared deployment path must agree, even in an isolated install root.
  const policies = loadRegistry(input.configDir).runtimes.flatMap(r => {
    if (!r.promptRetention || r.backend !== "llama-swap") return [];
    const command = swap.models?.[r.deployment.modelId]?.cmd;
    if (typeof command !== "string") throw new Error(`missing retention engine command for ${r.id}`);
    return command.split(/\s+/).includes("/etc/larm/prompt-retention.env.json") ? [r.promptRetention] : [];
  });
  if (policies.length === 0) return;
  if (policies.some(p => JSON.stringify(p) !== JSON.stringify(policies[0]))) throw new Error("shared engine environment requires matching retention policies");
  const keys = readRegular(input.credentialPath).split("\n").filter(line => line.startsWith("LARM_PROMPT_CACHE_KEY="));
  const key = keys[0]?.slice("LARM_PROMPT_CACHE_KEY=".length);
  if (keys.length !== 1 || !key || !/^[a-f0-9]{64}$/.test(key)) throw new Error("daemon retention key is missing or invalid");
  const data = { LARM_PROMPT_CACHE_KEY: key, LARM_PROMPT_CACHE_POLICY: JSON.stringify(policies[0]) };
  try {
    const existing = JSON.parse(readRegular(input.outputPath));
    if (existing.LARM_PROMPT_CACHE_KEY !== key) throw new Error("engine and daemon retention keys differ");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = resolve(dirname(input.outputPath), `.prompt-retention-${randomBytes(12).toString("hex")}.json`);
  try {
    writeFileSync(temporary, JSON.stringify(data) + "\n", { flag: "wx", mode: 0o600 });
    chownSync(temporary, input.uid, input.gid);
    renameSync(temporary, input.outputPath);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

if (import.meta.main) {
  const [configDir, credentialPath, outputPath, uidText, gidText] = process.argv.slice(2);
  const uid = Number(uidText), gid = Number(gidText);
  if (!configDir || !credentialPath || !outputPath || ![configDir, credentialPath, outputPath].every(isAbsolute)
    || uidText === undefined || gidText === undefined || !Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("usage: prepare-prompt-retention-environment.ts CONFIG CREDENTIAL_FILE OUTPUT UID GID");
  }
  preparePromptRetentionEnvironment({ configDir, credentialPath, outputPath, uid, gid });
  console.log("prompt retention environment prepared");
}
