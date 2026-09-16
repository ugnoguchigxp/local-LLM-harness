import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  artifactDownloadUrl,
  artifactFileDownloadUrl,
  computeSnapshotDigest,
  isFileArtifact,
  loadArtifactManifest,
  parseArtifactManifest,
} from "./artifacts";
import { loadRegistry } from "./registry";

test("loads the production artifact manifest and builds pinned download URLs", () => {
  const artifacts = loadArtifactManifest(
    join(import.meta.dir, "../../../deploy/local-node/models.yaml"),
  );
  const primary = artifacts.find((artifact) => artifact.id === "qwen38-primary")!;
  const mtp = artifacts.find((artifact) => artifact.id === "qwen38-mtp")!;
  const model35b = artifacts.find((artifact) => artifact.id === "qwen36-35b-speed")!;
  const decisionDefault = artifacts.find((artifact) => artifact.id === "qwen35-2b-q4-k-m")!;
  const lfmBackchannel = artifacts.find((artifact) => artifact.id === "lfm25-1.2b-jp-q4-k-m")!;
  const gemmaBackchannel = artifacts.find((artifact) => artifact.id === "gemma3-1b-it-q4-k-m")!;
  const ornith35b = artifacts.find((artifact) => artifact.id === "ornith15-35b-quality")!;
  const ornith35bSpeed = artifacts.find((artifact) => artifact.id === "ornith15-35b-speed")!;
  expect(isFileArtifact(primary)).toBe(true);
  if (
    !isFileArtifact(primary)
    || !isFileArtifact(mtp)
    || !isFileArtifact(model35b)
    || !isFileArtifact(decisionDefault)
    || !isFileArtifact(lfmBackchannel)
    || !isFileArtifact(gemmaBackchannel)
    || !isFileArtifact(ornith35b)
    || !isFileArtifact(ornith35bSpeed)
  ) {
    throw new Error("production GGUF artifacts must be files");
  }
  expect(artifactDownloadUrl(primary)).toContain(
    `/resolve/${primary.revision}/${primary.filename}`,
  );
  expect(artifactDownloadUrl(mtp)).toContain("/MTP/mtp-Qwen3.8-27B-Q4_0.gguf");
  expect(model35b).toEqual(expect.objectContaining({
    revision: "a483e9e6cbd595906af30beda3187c2663a1118c",
    bytes: 22_134_528_992,
    sha256: "ac0e2c1189e055faa36eff361580e79c5bd6f8e76bffb4ce547f167d53e31a61",
  }));
  expect(artifactDownloadUrl(model35b)).toContain(
    `/resolve/${model35b.revision}/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`,
  );
  expect(decisionDefault).toEqual(expect.objectContaining({
    revision: "f6d5376be1edb4d416d56da11e5397a961aca8ae",
    bytes: 1_280_835_840,
    sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
    quantization: "Q4_K_M",
  }));
  expect(artifactDownloadUrl(decisionDefault)).toContain(
    `/resolve/${decisionDefault.revision}/Qwen3.5-2B-Q4_K_M.gguf`,
  );
  expect(lfmBackchannel).toEqual(expect.objectContaining({
    revision: "170ae1cecf0e74b0b25bd704047160fba9f613c6",
    bytes: 730_895_296,
    sha256: "608beed14e975a4edd8932c42ac3e64cf1c97da4ee2c5f2c7b6bfbcdb1a90680",
    quantization: "Q4_K_M",
  }));
  expect(artifactDownloadUrl(lfmBackchannel)).toContain(
    `/resolve/${lfmBackchannel.revision}/LFM2.5-1.2B-JP-Q4_K_M.gguf`,
  );
  expect(gemmaBackchannel).toEqual(expect.objectContaining({
    revision: "f9c28bcd85737ffc5aef028638d3341d49869c27",
    bytes: 806_058_240,
    sha256: "8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135",
    quantization: "Q4_K_M",
  }));
  expect(artifactDownloadUrl(gemmaBackchannel)).toContain(
    `/resolve/${gemmaBackchannel.revision}/gemma-3-1b-it-Q4_K_M.gguf`,
  );
  expect(ornith35b).toEqual(expect.objectContaining({
    revision: "12393612fd4f730ff5aadc23e9b8f9648aa49ceb",
    bytes: 25_347_532_544,
    sha256: "91df97de5845100e850b4b5ec5ff35695382020b880fad6f7f51787b3a953bd0",
  }));
  expect(artifactDownloadUrl(ornith35b)).toContain(
    `/resolve/${ornith35b.revision}/Ornith-1.5-35B-Q5_K_M.gguf`,
  );
  expect(ornith35bSpeed).toEqual(expect.objectContaining({
    revision: "973bf694fdec212b833432d455611361bdeb914c",
    bytes: 19_052_439_552,
    sha256: "aa35045aab39163851c8584e6cf8cc6f33e8fc2ffe28ca627d3414ec66584704",
  }));
});

test("rejects unsafe artifact ids and non-absolute targets", () => {
  expect(() => parseArtifactManifest({
    models: {
      "../unsafe": {
        kind: "file",
        role: "test",
        source: "https://example.com/model.gguf",
        revision: "revision-1",
        filename: "model.gguf",
        path: "relative/model.gguf",
        bytes: 1,
        sha256: "0".repeat(64),
      },
    },
  })).toThrow();
});

test("rejects non-HTTP artifact sources", () => {
  expect(() => parseArtifactManifest({
    models: {
      unsafe: {
        kind: "file",
        role: "preferred-llm",
        source: "file:///etc/passwd",
        revision: "revision-1",
        filename: "model.gguf",
        path: "/srv/ai/models/model.gguf",
        bytes: 1,
        sha256: "0".repeat(64),
      },
    },
  })).toThrow(/source must use http or https/);
});

test("rejects unknown manifest fields and snapshot source suffixes", () => {
  expect(() => parseArtifactManifest({
    models: {
      unsafe: {
        kind: "file",
        role: "preferred-llm",
        source: "https://example.com/model.gguf",
        revision: "revision-1",
        filename: "model.gguf",
        path: "/srv/ai/models/model.gguf",
        bytes: 1,
        sha256: "0".repeat(64),
        checksun: "typo",
      },
    },
  })).toThrow(/checksun/);

  const files = [{ path: "config.json", bytes: 1, sha256: "0".repeat(64) }];
  expect(() => parseArtifactManifest({
    models: {
      unsafe: {
        kind: "snapshot",
        role: "preferred-tts",
        source: "https://example.com/model?token=unexpected",
        revision: "revision-1",
        path: "/srv/ai/models/model",
        totalBytes: 1,
        maxFiles: 1,
        snapshotDigest: computeSnapshotDigest(files),
        files,
      },
    },
  })).toThrow(/base URL/);
});

test("rejects incomplete single-file metadata and unsafe filenames", () => {
  expect(() => parseArtifactManifest({
    models: {
      partial: {
        kind: "file",
        role: "preferred-llm",
        source: "https://example.com/model.gguf",
        filename: "model.gguf",
        path: "/srv/ai/models/model.gguf",
      },
    },
  })).toThrow(/revision/);
  expect(() => parseArtifactManifest({
    models: {
      unsafe: {
        kind: "file",
        role: "preferred-llm",
        source: "https://example.com/model.gguf",
        revision: "revision-1",
        filename: "../model.gguf",
        path: "/srv/ai/models/model.gguf",
        bytes: 1,
        sha256: "0".repeat(64),
      },
    },
  })).toThrow(/safe base name/);
  expect(() => parseArtifactManifest({
    models: {
      unsafe: {
        kind: "file",
        role: "preferred-llm",
        source: "https://example.com/model.gguf",
        revision: "../../escape",
        filename: "model.gguf",
        path: "/srv/ai/models/model.gguf",
        bytes: 1,
        sha256: "0".repeat(64),
      },
    },
  })).toThrow(/safe relative path/);
});

test("does not treat a lookalike host as Hugging Face", () => {
  const [artifact] = parseArtifactManifest({
    models: {
      model: {
        kind: "file",
        role: "preferred-llm",
        source: "https://example.com/huggingface.co/model.gguf",
        revision: "revision-1",
        filename: "model.gguf",
        path: "/srv/ai/models/model.gguf",
        bytes: 1,
        sha256: "0".repeat(64),
      },
    },
  });
  expect(artifactDownloadUrl(artifact!)).toBe("https://example.com/huggingface.co/model.gguf");
});

test("parses a canonical directory snapshot and builds per-file pinned URLs", () => {
  const files = [
    { path: "config.json", bytes: 2, sha256: "1".repeat(64) },
    { path: "weights/model.safetensors", bytes: 3, sha256: "2".repeat(64) },
  ];
  const [artifact] = parseArtifactManifest({
    models: {
      snapshot: {
        kind: "snapshot",
        role: "preferred-tts",
        source: "https://huggingface.co/example/model",
        revision: "revision-1",
        path: "/srv/ai/models/example",
        totalBytes: 5,
        maxFiles: 2,
        snapshotDigest: computeSnapshotDigest(files),
        files,
      },
    },
  });
  if (!artifact || artifact.kind !== "snapshot") {
    throw new Error("snapshot artifact was not parsed");
  }
  expect(artifactFileDownloadUrl(artifact, artifact.files[1])).toBe(
    "https://huggingface.co/example/model/resolve/revision-1/weights/model.safetensors",
  );
});

test("rejects non-canonical, colliding, traversing, and digest-mismatched snapshots", () => {
  const base = {
    kind: "snapshot",
    role: "preferred-tts",
    source: "https://huggingface.co/example/model",
    revision: "revision-1",
    path: "/srv/ai/models/example",
    totalBytes: 2,
    maxFiles: 2,
    snapshotDigest: "0".repeat(64),
  };
  for (const files of [
    [
      { path: "b", bytes: 1, sha256: "1".repeat(64) },
      { path: "a", bytes: 1, sha256: "2".repeat(64) },
    ],
    [
      { path: "A", bytes: 1, sha256: "1".repeat(64) },
      { path: "a", bytes: 1, sha256: "2".repeat(64) },
    ],
    [
      { path: "../escape", bytes: 1, sha256: "1".repeat(64) },
      { path: "safe", bytes: 1, sha256: "2".repeat(64) },
    ],
  ]) {
    expect(() => parseArtifactManifest({ models: { unsafe: { ...base, files } } })).toThrow();
  }
  const validFiles = [
    { path: "a", bytes: 1, sha256: "1".repeat(64) },
    { path: "b", bytes: 1, sha256: "2".repeat(64) },
  ];
  expect(() => parseArtifactManifest({
    models: { unsafe: { ...base, files: validFiles } },
  })).toThrow(/snapshotDigest/);
});

test("every production runtime artifact reference exists in the manifest", () => {
  const root = join(import.meta.dir, "../../..");
  const artifacts = new Set(
    loadArtifactManifest(join(root, "deploy/local-node/models.yaml")).map((artifact) => artifact.id),
  );
  const registry = loadRegistry(join(root, "config/local-node"));
  for (const runtime of registry.runtimes) {
    for (const artifactId of runtime.artifacts ?? []) {
      expect(artifacts.has(artifactId)).toBe(true);
    }
  }
});

test("Qwen TTS service configuration consumes the manifest-managed snapshot target", () => {
  const root = join(import.meta.dir, "../../..");
  const artifact = loadArtifactManifest(join(root, "deploy/local-node/models.yaml"))
    .find((candidate) => candidate.id === "qwen3-tts-expressive");
  if (!artifact || artifact.kind !== "snapshot") {
    throw new Error("Qwen TTS snapshot artifact is missing");
  }
  const config = parseYaml(
    readFileSync(join(root, "apps/qwen-tts/config.production.yaml"), "utf8"),
  ) as { default_model?: string; models?: Record<string, { hf_id?: string }> };
  expect(config.default_model).toBe("0.6B-CustomVoice");
  expect(config.models?.[config.default_model ?? ""]?.hf_id).toBe(artifact.path);
  const qwenPatch = readFileSync(join(root, "apps/qwen-tts/rocm-gfx1151.patch"), "utf8");
  expect(qwenPatch.match(/\+    "qwen3-tts-expressive":/g)).toHaveLength(2);

  const registry = loadRegistry(join(root, "config/local-node"));
  expect(registry.runtimes.find((runtime) => runtime.id === "qwen-tts")?.artifacts)
    .toContain(artifact.id);
  const daemonUnit = readFileSync(join(root, "deploy/local-node/systemd/larm-daemon.service"), "utf8");
  expect(daemonUnit)
    .toContain("ReadWritePaths=/srv/ai/cache /srv/ai/context-snapshots /srv/ai/context-sources /srv/ai/logs /srv/ai/models /var/lib/larm");
  expect(daemonUnit).toContain("Environment=LARM_CONNECTION_READY_TIMEOUT_SECONDS=300");
});
