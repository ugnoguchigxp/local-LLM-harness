import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
    expect(defaultRuntimeRelease(releases, "qwen35-decision")).toMatchObject({
      id: "qwen35-decision-current",
      artifacts: ["qwen35-2b-q4-k-m"],
      providerConfigRevision: "llama-swap-qwen35-2b-q4-k-m-decision-4k-v1",
      estimatedMemoryGB: 4,
    });
    expect(defaultRuntimeRelease(releases, "ornith15-35b")?.artifacts).toEqual([
      "ornith15-35b-quality",
    ]);
    expect(defaultRuntimeRelease(releases, "ornith15-35b-speed")?.artifacts).toEqual([
      "ornith15-35b-speed",
    ]);
    expect(registry.runtimes.find((runtime) => runtime.id === "qwen-general")?.context)
      .toMatchObject({ class: "managed-context", sourceTokenLimit: 20_000_000 });
    expect(registry.runtimes.find((runtime) => runtime.id === "qwen-worker-quality")?.context)
      .toMatchObject({
        class: "managed-context",
        materializedRetentionTargetTokens: 20_000_000,
        nvmeCacheMaxBytes: 512 * 1024 * 1024 * 1024,
      });
    const sourceEvidenceDigest = createHash("sha256")
      .update(readFileSync(`${root}specs/context-source-rebuild-evidence.html`))
      .digest("hex");
    expect(defaultRuntimeRelease(releases, "qwen-general")?.contextCertification?.evidenceDigest)
      .toBe(sourceEvidenceDigest);
    const snapshotEvidenceDigest = createHash("sha256")
      .update(readFileSync(`${root}specs/context-m3b-crc32c-evidence.html`))
      .digest("hex");
    expect(defaultRuntimeRelease(releases, "qwen-worker-quality")?.contextCertification)
      .toMatchObject({
        profile: "qwen38-quality-crc32c-v1",
        providerConfigRevision: "llama-swap-qwen-quality-snapshot-v2",
        stateFormat: "llama-slot-crc32c-v1",
        cacheTypeK: "q4_0",
        cacheTypeV: "q4_0",
        verifiedModes: ["source-rebuild", "session-snapshot"],
        evidenceDigest: snapshotEvidenceDigest,
      });
    expect(defaultRuntimeRelease(releases, "qwen-worker-agent-efficientthink")).toMatchObject({
      id: "qwen-worker-agent-efficientthink-v1",
      artifacts: ["qwen38-worker-efficientthink-q3", "qwen38-efficientthink-mtp"],
    });
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
