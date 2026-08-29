import { describe, expect, test } from "bun:test";
import { loadArtifactManifest } from "./artifacts";
import { loadRegistry } from "./registry";
import {
  defaultRuntimeRelease,
  loadRuntimeReleaseCatalog,
  parseRuntimeReleaseCatalog,
} from "./releases";

const root = new URL("../../../", import.meta.url).pathname;
const registry = loadRegistry(`${root}config/local-node`);
const artifacts = loadArtifactManifest(`${root}deploy/local-node/models.yaml`);

describe("runtime release catalog", () => {
  test("loads immutable production releases with one default per artifact runtime", () => {
    const releases = loadRuntimeReleaseCatalog(`${root}deploy/local-node/releases.yaml`, registry, artifacts);
    expect(defaultRuntimeRelease(releases, "qwen-general")?.artifacts).toEqual(["qwen38-primary"]);
    expect(defaultRuntimeRelease(releases, "qwen36-35b")?.artifacts).toEqual(["qwen36-35b-speed"]);
    expect(defaultRuntimeRelease(releases, "ornith15-35b")?.artifacts).toEqual([
      "ornith15-35b-quality",
    ]);
    expect(defaultRuntimeRelease(releases, "ornith15-35b-speed")?.artifacts).toEqual([
      "ornith15-35b-speed",
    ]);
    expect(defaultRuntimeRelease(releases, "qwen-tts")?.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects unknown artifacts and duplicate defaults", () => {
    expect(() => parseRuntimeReleaseCatalog({
      runtimeReleases: {
        first: {
          runtime: "qwen-general",
          artifacts: ["missing"],
          providerConfigRevision: "v1",
          estimatedMemoryGB: 40,
          default: true,
        },
      },
    }, registry, artifacts)).toThrow(/unknown artifact/);

    const current = {
      runtime: "qwen-general",
      artifacts: ["qwen38-primary"],
      providerConfigRevision: "v1",
      estimatedMemoryGB: 40,
      default: true,
    };
    expect(() => parseRuntimeReleaseCatalog({
      runtimeReleases: { first: current, second: current },
    }, registry, artifacts)).toThrow(/multiple defaults/);
  });

  test("requires default releases to match the runtime artifact set", () => {
    expect(() => parseRuntimeReleaseCatalog({
      runtimeReleases: {
        bad: {
          runtime: "qwen-worker-quality",
          artifacts: ["qwen38-worker-quality"],
          providerConfigRevision: "v1",
          estimatedMemoryGB: 40,
          default: true,
        },
      },
    }, registry, artifacts)).toThrow(/must match/);
  });

  test("rejects a release whose memory estimate escapes the static admission bound", () => {
    expect(() => parseRuntimeReleaseCatalog({
      runtimeReleases: {
        oversized: {
          runtime: "qwen-general",
          artifacts: ["qwen38-primary"],
          providerConfigRevision: "v1",
          estimatedMemoryGB: 10_000,
          default: true,
        },
      },
    }, registry, artifacts)).toThrow(
      /static runtime admission bound/,
    );
  });
});
