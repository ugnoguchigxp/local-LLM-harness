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
    expect(defaultRuntimeRelease(releases, "qwen-worker-fast")).toMatchObject({
      id: "qwen-worker-fast-current",
      providerConfigRevision: "llama-swap-qwen-q4-0-mtp-225k-ubatch256-v1",
    });
    expect(defaultRuntimeRelease(releases, "qwen36-35b")?.artifacts).toEqual(["qwen36-35b-speed"]);
    expect(defaultRuntimeRelease(releases, "qwen35-decision")).toMatchObject({
      id: "qwen35-decision-current",
      artifacts: ["qwen35-2b-q4-k-m"],
      providerConfigRevision: "llama-swap-qwen35-2b-q4-k-m-decision-4k-v1",
      estimatedMemoryGB: 4,
    });
    expect(defaultRuntimeRelease(releases, "lfm25-backchannel-jp")).toMatchObject({
      id: "lfm25-backchannel-jp-current",
      artifacts: ["lfm25-1.2b-jp-q4-k-m"],
      providerConfigRevision: "llama-swap-lfm25-1.2b-jp-q4-k-m-backchannel-64k-warm-schema-v1",
      estimatedMemoryGB: 3,
    });
    expect(defaultRuntimeRelease(releases, "gemma3-backchannel")).toMatchObject({
      id: "gemma3-backchannel-current",
      artifacts: ["gemma3-1b-it-q4-k-m"],
      estimatedMemoryGB: 3,
    });
    expect(defaultRuntimeRelease(releases, "ornith15-35b")?.artifacts).toEqual([
      "ornith15-35b-quality",
    ]);
    expect(defaultRuntimeRelease(releases, "ornith15-35b-speed")?.artifacts).toEqual([
      "ornith15-35b-speed",
    ]);
    expect(registry.runtimes.find((runtime) => runtime.id === "qwen-general")?.context)
      .toMatchObject({ class: "managed-context", sourceTokenLimit: 20_000_000 });
    const sourceEvidenceDigest = createHash("sha256")
      .update(readFileSync(`${root}specs/context-source-rebuild-evidence.html`))
      .digest("hex");
    expect(defaultRuntimeRelease(releases, "qwen-general")?.contextCertification?.evidenceDigest)
      .toBe(sourceEvidenceDigest);
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
          runtime: "qwen-worker-agent",
          artifacts: ["qwen38-worker-quality"],
          providerConfigRevision: "v1",
          estimatedMemoryGB: 28,
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
