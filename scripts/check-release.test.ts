import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRelease, classifyAudit, releaseInputDigest } from "./check-release";

function fixture(overrides: Partial<Parameters<typeof checkRelease>[0]> = {}) {
  const calls: string[][] = [];
  return { calls, options: {
    sourceCommit: "a".repeat(40), bunVersion: "1.4.0", expectedBunVersion: "1.4.0",
    lockfileSha256: "d".repeat(64),
    readInputs: async () => "b".repeat(64),
    run: async (args: readonly string[]) => { calls.push([...args]); return { exitCode: 0, stdout: "{}" }; },
    ...overrides,
  } };
}

test("release gate runs the mandatory checks and records immutable input identity", async () => {
  const { options, calls } = fixture({ sourceDirty: true });
  expect(await checkRelease(options)).toMatchObject({ passed: true, sourceDirty: true, sourceCommit: "a".repeat(40), inputDigest: "b".repeat(64),
    checks: ["install", "audit", "check", "coverage"].map(id => ({ id, status: "passed" })) });
  expect(calls).toEqual([["install", "--frozen-lockfile"], ["audit", "--json", "--audit-level=high"], ["audit", "--json", "--audit-level=high", "--prod"], ["run", "check"], ["run", "test:coverage"]]);
});

test("audit distinguishes advisory failures from missing or malformed service responses", () => {
  for (const severity of ["high", "critical"]) {
    expect(classifyAudit({ exitCode: 1, stdout: JSON.stringify({ dependency: [{ severity }] }) })).toEqual({ status: "failed", code: "high_severity_advisory" });
  }
  expect(classifyAudit({ exitCode: 0, stdout: '{"dependency":[{"severity":"moderate"}]}' })).toEqual({ status: "passed" });
  for (const stdout of ["", "service unavailable", "[]", "null", '{"error":"timeout"}', '{"x":[{}]}']) {
    expect(classifyAudit({ exitCode: 1, stdout })).toEqual({ status: "unavailable", code: "audit_unavailable" });
  }
  expect(classifyAudit({ exitCode: 1, stdout: "{}" }).status).toBe("unavailable");
});

test("every failed check stops the candidate before later checks", async () => {
  for (const failure of ["install", "audit", "check", "test:coverage"]) {
    const calls: string[] = [];
    const { options } = fixture({ run: async args => {
      const name = args[0] === "run" ? args[1]! : args[0]!;
      calls.push(name);
      return { exitCode: name === failure ? 1 : 0, stdout: name === "audit" && failure === "audit" ? '{"x":[{"severity":"high"}]}' : "{}" };
    } });
    const result = await checkRelease(options);
    expect(result.passed).toBe(false);
    expect(calls.at(-1)).toBe(failure);
    expect(result.checks.at(-1)?.status).toBe("failed");
  }
});

test("version mismatch, invalid revision, execution failure and changed inputs fail closed", async () => {
  expect((await checkRelease(fixture({ bunVersion: "1.4.1" }).options)).error).toBe("bun_version_mismatch");
  expect((await checkRelease(fixture({ sourceCommit: "HEAD" }).options)).error).toBe("invalid_source_commit");
  expect((await checkRelease(fixture({ lockfileSha256: "invalid" }).options)).error).toBe("invalid_lockfile_digest");
  expect((await checkRelease(fixture({ run: async () => { throw new Error("offline"); } }).options)).checks[0]?.status).toBe("unavailable");
  let reads = 0;
  const { options, calls } = fixture({ readInputs: async () => ++reads === 1 ? "initial" : "changed" });
  expect((await checkRelease(options)).error).toBe("release_inputs_changed");
  expect(calls).toHaveLength(1);
});

test("production audit unavailability stops the gate even after a successful all-dependency audit", async () => {
  const { options, calls } = fixture();
  const run = options.run;
  options.run = async args => args.includes("--prod") ? { exitCode: 1, stdout: "offline" } : run(args);
  const receipt = await checkRelease(options);
  expect(receipt.passed).toBe(false);
  expect(receipt.productionAudit).toEqual({ status: "unavailable", code: "audit_unavailable" });
  expect(calls).toHaveLength(2);
});

test("release inputs detect lock and workspace declaration edits and additions", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-release-inputs-"));
  try {
    await writeFile(join(root, "bun.lock"), "lock");
    await writeFile(join(root, "package.json"), "{}");
    await mkdir(join(root, "packages", "test"), { recursive: true });
    const initial = await releaseInputDigest(root);
    await writeFile(join(root, "packages", "test", "package.json"), "{}");
    const added = await releaseInputDigest(root);
    expect(added).not.toBe(initial);
    await writeFile(join(root, "packages", "test", "package.json"), '{"dependencies":{"x":"1"}}');
    expect(await releaseInputDigest(root)).not.toBe(added);
    await writeFile(join(root, "bun.lock"), "changed");
    expect(await releaseInputDigest(root)).not.toBe(initial);
    const source = await releaseInputDigest(root);
    await writeFile(join(root, "release-gate.json"), "generated receipt");
    await mkdir(join(root, "coverage"));
    await writeFile(join(root, "coverage", "lcov.info"), "coverage output");
    expect(await releaseInputDigest(root)).toBe(source);
    await writeFile(join(root, "README.md"), "changed source");
    expect(await releaseInputDigest(root)).not.toBe(source);
  } finally { await rm(root, { recursive: true, force: true }); }
});
