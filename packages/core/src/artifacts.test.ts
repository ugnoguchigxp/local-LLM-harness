import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  artifactDownloadUrl,
  loadArtifactManifest,
  parseArtifactManifest,
} from "./artifacts";
import { loadRegistry } from "./registry";

test("loads the production artifact manifest and builds pinned download URLs", () => {
  const artifacts = loadArtifactManifest(
    join(import.meta.dir, "../../../deploy/gnosis/models.yaml"),
  );
  const primary = artifacts.find((artifact) => artifact.id === "qwen38-primary")!;
  const mtp = artifacts.find((artifact) => artifact.id === "qwen38-mtp")!;
  expect(artifactDownloadUrl(primary)).toContain(
    `/resolve/${primary.revision}/${primary.filename}`,
  );
  expect(artifactDownloadUrl(mtp)).toContain("/MTP/mtp-Qwen3.8-27B-Q4_0.gguf");
});

test("rejects unsafe artifact ids and non-absolute targets", () => {
  expect(() => parseArtifactManifest({
    models: {
      "../unsafe": {
        role: "test",
        source: "https://example.com/model.gguf",
        path: "relative/model.gguf",
      },
    },
  })).toThrow();
});

test("rejects non-HTTP artifact sources", () => {
  expect(() => parseArtifactManifest({
    models: {
      unsafe: {
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

test("rejects incomplete single-file metadata and unsafe filenames", () => {
  expect(() => parseArtifactManifest({
    models: {
      partial: {
        role: "preferred-llm",
        source: "https://example.com/model.gguf",
        filename: "model.gguf",
        path: "/srv/ai/models/model.gguf",
      },
    },
  })).toThrow(/revision is required/);
  expect(() => parseArtifactManifest({
    models: {
      unsafe: {
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

test("every production runtime artifact reference exists in the manifest", () => {
  const root = join(import.meta.dir, "../../..");
  const artifacts = new Set(
    loadArtifactManifest(join(root, "deploy/gnosis/models.yaml")).map((artifact) => artifact.id),
  );
  const registry = loadRegistry(join(root, "config/gnosis"));
  for (const runtime of registry.runtimes) {
    for (const artifactId of runtime.artifacts ?? []) {
      expect(artifacts.has(artifactId)).toBe(true);
    }
  }
});
