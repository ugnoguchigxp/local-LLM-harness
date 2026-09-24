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
    expect(defaultRuntimeRelease(releases, "ornith-general")).toMatchObject({
      id: "ornith-general-current",
      artifacts: ["ornith15-35b-speed"],
      providerConfigRevision: "llama-server-ornith15-rocmfp4-128k-mtp-n4-p06-v1",
      estimatedMemoryGB: 40,
    });
    expect(defaultRuntimeRelease(releases, "qwen-worker-fast")).toMatchObject({
      id: "qwen-worker-fast-current",
      providerConfigRevision: "llama-swap-qwen-q4-0-mtp-225k-ubatch256-v1",
    });
    expect(defaultRuntimeRelease(releases, "qwen36-35b")?.artifacts).toEqual(["qwen36-35b-speed"]);
    expect(defaultRuntimeRelease(releases, "qwen35-decision")).toMatchObject({
      id: "qwen35-decision-current",
      artifacts: ["qwen35-2b-q4-k-m"],
      providerConfigRevision: "llama-swap-qwen35-2b-q4-k-m-decision-64k-v2",
      estimatedMemoryGB: 8,
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
    expect(registry.runtimes.find((runtime) => runtime.id === "ornith-general")?.context)
      .toMatchObject({ class: "managed-context", sourceTokenLimit: 20_000_000 });
    expect(defaultRuntimeRelease(releases, "ornith-general")?.contextCertification)
      .toBeUndefined();
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
          runtime: "ornith-general",
          artifacts: ["missing"],
          providerConfigRevision: "v1",
          estimatedMemoryGB: 40,
          default: true,
        },
      },
    }, registry, artifacts)).toThrow(/unknown artifact/);

    const current = {
      runtime: "ornith-general",
      artifacts: ["ornith15-35b-speed"],
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
          runtime: "ornith-general",
          artifacts: ["ornith15-35b-speed"],
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
