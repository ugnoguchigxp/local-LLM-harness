import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStoreError } from "./artifact-store-errors";
import { hashArtifactFile, throwIfAborted } from "./artifact-store-safety";

test("hashing refuses a symbolic link and a non-file target", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-artifact-safety-"));
  try {
    const file = join(root, "data");
    const alias = join(root, "alias");
    const directory = join(root, "directory");
    await writeFile(file, "safe");
    await symlink(file, alias);
    await mkdir(directory);

    await expect(hashArtifactFile(alias)).rejects.toBeInstanceOf(ArtifactStoreError);
    await expect(hashArtifactFile(directory)).rejects.toMatchObject({ code: "unsafe_target" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("abort helper preserves Error reasons and safely handles arbitrary reasons", () => {
  const errorController = new AbortController();
  errorController.abort(new Error("daemon draining"));
  expect(() => throwIfAborted(errorController.signal)).toThrow("daemon draining");

  const valueController = new AbortController();
  valueController.abort("cancelled by caller");
  expect(() => throwIfAborted(valueController.signal)).toThrow("artifact operation cancelled");
  expect(() => throwIfAborted()).not.toThrow();
});
