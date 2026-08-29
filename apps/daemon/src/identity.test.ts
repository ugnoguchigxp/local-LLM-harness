import { expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeConfigRevision, createBootEpoch, loadReleaseCommit } from "./identity";

test("boot epochs are header-safe and reject weak sources", () => {
  expect(createBootEpoch(() => "12345678-AB_cd!")).toBe("epoch-12345678-ABcd");
  expect(() => createBootEpoch(() => "short")).toThrow(/at least 8/);
});

test("config revision covers every registry file and both deployment manifests", async () => {
  const root = await Bun.$`mktemp -d`.text().then((value) => value.trim());
  const config = join(root, "config");
  const manifest = join(root, "models.yaml");
  const relocatedConfig = join(root, "relocated", "config");
  const relocatedManifest = join(root, "relocated", "manifest.yaml");
  const releases = join(root, "releases.yaml");
  const relocatedReleases = join(root, "relocated", "releases.yaml");
  try {
    await mkdir(config);
    await mkdir(relocatedConfig, { recursive: true });
    for (const file of [
      "nodes.yaml",
      "runtimes.yaml",
      "profiles.yaml",
      "routes.yaml",
      "agent-connections.yaml",
    ]) {
      await writeFile(join(config, file), `${file}: original\n`);
      await writeFile(join(relocatedConfig, file), `${file}: original\n`);
    }
    await writeFile(manifest, "models: {}\n");
    await writeFile(relocatedManifest, "models: {}\n");
    await writeFile(releases, "runtimeReleases: {}\n");
    await writeFile(relocatedReleases, "runtimeReleases: {}\n");
    const before = computeConfigRevision(config, manifest, releases);
    expect(computeConfigRevision(relocatedConfig, relocatedManifest, relocatedReleases)).toBe(before);
    await writeFile(join(config, "routes.yaml"), "routes: changed\n");
    expect(computeConfigRevision(config, manifest, releases)).not.toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release identity is loaded from a strict manifest", async () => {
  const root = await Bun.$`mktemp -d`.text().then((value) => value.trim());
  const manifest = join(root, "release-manifest.json");
  try {
    expect(loadReleaseCommit(undefined)).toBe("development");
    const valid = {
      schemaVersion: 1,
      commit: "a".repeat(40),
      larmVersion: "0.1.0",
      bunVersion: "1.4.0",
      lockfileSha256: "b".repeat(64),
      nodeModulesSha256: "d".repeat(64),
      configRevision: "c".repeat(64),
      createdAt: "2026-08-29T00:00:00Z",
    };
    await writeFile(manifest, JSON.stringify(valid));
    expect(loadReleaseCommit(manifest)).toBe("a".repeat(40));
    await writeFile(manifest, JSON.stringify({ ...valid, commit: "main" }));
    expect(() => loadReleaseCommit(manifest)).toThrow(/manifest is invalid/);
    await writeFile(manifest, JSON.stringify({ ...valid, unexpected: true }));
    expect(() => loadReleaseCommit(manifest)).toThrow(/manifest is invalid/);
    await writeFile(manifest, JSON.stringify({ ...valid, configRevision: "test-gate-skipped" }));
    expect(() => loadReleaseCommit(manifest)).toThrow(/manifest is invalid/);
    const manifestTarget = join(root, "manifest-target.json");
    await writeFile(manifestTarget, JSON.stringify(valid));
    await rm(manifest);
    await symlink(manifestTarget, manifest);
    expect(() => loadReleaseCommit(manifest)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
