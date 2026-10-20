import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ComputeStore } from "./store";

test("compute refuses a database symlink without touching its target", () => {
  const root = mkdtempSync(join(tmpdir(), "compute-store-path-"));
  try {
    const target = join(root, "private.txt"); writeFileSync(target, "keep", { mode: 0o640 });
    symlinkSync(target, join(root, "compute.sqlite"));
    expect(() => new ComputeStore(root)).toThrow("symlinks");
    expect(readFileSync(target, "utf8")).toBe("keep"); expect(statSync(target).mode & 0o777).toBe(0o640);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compute refuses root directory aliases before changing permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "compute-root-alias-"));
  const mode = statSync("/").mode;
  try {
    const alias = join(root, "alias"); symlinkSync("/", alias);
    expect(() => new ComputeStore(alias)).toThrow("dedicated");
    expect(statSync("/").mode).toBe(mode);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compute releases failed initialization connections and supports idempotent close", () => {
  const root = mkdtempSync(join(tmpdir(), "compute-store-owner-"));
  const first = new ComputeStore(root);
  try {
    expect(() => new ComputeStore(root)).toThrow("initialization failed");
    first.close(); first.close();
    const reopened = new ComputeStore(root); expect(reopened.summaries()).toEqual([]); reopened.close();
  } finally { first.close(); rmSync(root, { recursive: true, force: true }); }
});
