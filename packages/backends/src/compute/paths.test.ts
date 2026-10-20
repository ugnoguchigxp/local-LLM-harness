import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertComputeStorageIsolation } from "./paths";

test("compute directory isolation resolves symlinks and missing descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "compute-paths-"));
  try {
    const runtime = join(root, "runtime"); mkdirSync(runtime);
    const alias = join(root, "alias"); symlinkSync(runtime, alias);
    expect(() => assertComputeStorageIsolation(join(alias, "missing/state"), runtime)).toThrow("disjoint");
    expect(() => assertComputeStorageIsolation(alias, join(runtime, "venv"))).toThrow("disjoint");
    expect(() => assertComputeStorageIsolation("/", runtime)).toThrow("dedicated");
    expect(() => assertComputeStorageIsolation(join(root, "state"), runtime)).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
