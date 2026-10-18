import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { lstat, readlink } from "node:fs/promises";

export const RELEASE_CHECKS = [
  { id: "install", args: ["install", "--frozen-lockfile"] },
  { id: "audit", args: ["audit", "--json", "--audit-level=high"] },
  { id: "check", args: ["run", "check"] },
  { id: "coverage", args: ["run", "test:coverage"] },
] as const;

type CheckId = typeof RELEASE_CHECKS[number]["id"];
type CheckResult = { id: CheckId; status: "passed" | "failed" | "unavailable"; code?: string };
export type ReleaseGateReceipt = {
  schemaVersion: 1;
  kind: "larm-release-gate";
  passed: boolean;
  sourceCommit: string;
  sourceDirty: boolean;
  bunVersion: string;
  inputDigest: string;
  lockfileSha256: string;
  recordedAt: string;
  checks: CheckResult[];
  productionAudit?: Omit<CheckResult, "id">;
  error?: string;
};

/** Pure orchestration entry point; the CLI has no skip/check-selection switches. */
export async function checkRelease(options: {
  sourceCommit: string;
  sourceDirty?: boolean;
  bunVersion: string;
  expectedBunVersion: string;
  lockfileSha256: string;
  readInputs: () => Promise<string>;
  run: (args: readonly string[]) => Promise<{ exitCode: number; stdout?: string }>;
  now?: () => Date;
}): Promise<ReleaseGateReceipt> {
  const receipt: ReleaseGateReceipt = {
    schemaVersion: 1, kind: "larm-release-gate", passed: false,
    sourceCommit: options.sourceCommit, sourceDirty: options.sourceDirty ?? false, bunVersion: options.bunVersion,
    inputDigest: "", lockfileSha256: options.lockfileSha256,
    recordedAt: (options.now?.() ?? new Date()).toISOString(), checks: [],
  };
  try {
    if (!/^[a-f0-9]{40}$/.test(options.sourceCommit)) throw new Error("invalid_source_commit");
    if (options.bunVersion !== options.expectedBunVersion) throw new Error("bun_version_mismatch");
    if (!/^[a-f0-9]{64}$/.test(options.lockfileSha256)) throw new Error("invalid_lockfile_digest");
    receipt.inputDigest = await options.readInputs();
    for (const check of RELEASE_CHECKS) {
      let result: Awaited<ReturnType<typeof options.run>>;
      try { result = await options.run(check.args); }
      catch { receipt.checks.push({ id: check.id, status: "unavailable", code: "command_unavailable" }); return receipt; }
      if (check.id === "audit") {
        const audit = classifyAudit(result);
        receipt.checks.push({ id: check.id, ...audit });
        if (audit.status !== "passed") return receipt;
        receipt.productionAudit = classifyAudit(await options.run([...check.args, "--prod"]));
        if (receipt.productionAudit.status !== "passed") return receipt;
      } else {
        receipt.checks.push({ id: check.id, status: result.exitCode === 0 ? "passed" : "failed" });
        if (result.exitCode !== 0) return receipt;
      }
      if (await options.readInputs() !== receipt.inputDigest) throw new Error("release_inputs_changed");
    }
    receipt.passed = true;
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : "release_gate_failed";
  }
  return receipt;
}

export function classifyAudit(result: { exitCode: number; stdout?: string }): Omit<CheckResult, "id"> {
  try {
    const audit: unknown = JSON.parse(result.stdout ?? "");
    if (audit === null || typeof audit !== "object" || Array.isArray(audit)) throw new Error();
    let high = false;
    for (const entries of Object.values(audit)) {
      if (!Array.isArray(entries)) throw new Error();
      for (const advisory of entries) {
        if (!advisory || typeof advisory !== "object"
          || !["low", "moderate", "high", "critical"].includes(advisory.severity)) throw new Error();
        high ||= advisory.severity === "high" || advisory.severity === "critical";
      }
    }
    if (high) return { status: "failed", code: "high_severity_advisory" };
    return result.exitCode === 0 ? { status: "passed" } : { status: "unavailable", code: "audit_unavailable" };
  } catch { return { status: "unavailable", code: "audit_unavailable" }; }
}

/** Hash source contents in worktrees and exported archives; exclude generated evidence. */
export async function releaseInputDigest(root: string): Promise<string> {
  const worktree = await Bun.file(resolve(root, ".git/HEAD")).exists();
  const sourceFiles = worktree
    ? Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
    : undefined;
  if (sourceFiles && sourceFiles.exitCode !== 0) throw new Error("source_inventory_unavailable");
  const paths = [...new Set(sourceFiles
    ? sourceFiles.stdout.toString().split("\0").filter(Boolean)
    : [...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true, dot: true })]
  )].filter(path => !/(^|\/)(?:node_modules|\.git|coverage|__pycache__|\.cache|\.venv)(?:\/|$)/.test(path)
    && !/\.py[co]$/.test(path) && !["release-gate.json", "release-manifest.json"].includes(path)).sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    const file = resolve(root, path);
    let metadata;
    try { metadata = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    hash.update(path).update("\0");
    if (metadata.isSymbolicLink()) hash.update("symlink\0").update(await readlink(file));
    else if (metadata.isFile()) hash.update("file\0").update(new Uint8Array(await Bun.file(file).arrayBuffer()));
    else throw new Error("unsupported_source_entry");
    hash.update("\0");
  }
  return hash.digest("hex");
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const manager = (await Bun.file(resolve(root, "package.json")).json()).packageManager;
  const expectedBunVersion = typeof manager === "string" && /^bun@\d+\.\d+\.\d+$/.test(manager)
    ? manager.slice(4) : "invalid_package_manager";
  let sourceCommit = process.env.LARM_RELEASE_GATE_COMMIT ?? "";
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=normal"], { cwd: root, stderr: "ignore" });
  const sourceDirty = status.exitCode === 0 && status.stdout.length > 0;
  if (!sourceCommit) {
    const git = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "ignore" });
    sourceCommit = (await new Response(git.stdout).text()).trim();
    if (await git.exited !== 0) sourceCommit = "";
  }
  const receipt = await checkRelease({
    sourceCommit, sourceDirty, bunVersion: Bun.version, expectedBunVersion,
    lockfileSha256: createHash("sha256").update(new Uint8Array(await Bun.file(resolve(root, "bun.lock")).arrayBuffer())).digest("hex"),
    readInputs: () => releaseInputDigest(root),
    run: async args => {
      console.error(`release gate: ${args[0] === "run" ? args[1] : args[0]}`);
      const audit = args[0] === "audit";
      const child = Bun.spawn([process.execPath, ...args], {
        cwd: root, env: process.env, stdout: audit ? "pipe" : 2, stderr: "inherit",
      });
      // Forward ordinary command output to stderr so stdout remains a JSON receipt.
      const stdout = audit ? await new Response(child.stdout as ReadableStream).text() : undefined;
      return { exitCode: await child.exited, stdout };
    },
  });
  console.log(JSON.stringify(receipt));
  if (!receipt.passed) process.exitCode = 1;
}
