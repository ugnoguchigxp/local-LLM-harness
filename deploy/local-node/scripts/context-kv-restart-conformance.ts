import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { LocalContextSnapshotStore, LlamaContextSlotAdapter } from "../../../packages/backends/src";
import { contextSnapshotManifestSchema, type ContextSnapshotManifest } from "../../../packages/core/src";

type Json = Record<string, unknown>;
const digest = (value: unknown) => createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(value))
  .digest("hex");
const endpoint = (process.env.LARM_CONTEXT_SPIKE_ENDPOINT ?? "http://127.0.0.1:59001").replace(/\/$/, "");
const configuredRoot = process.env.LARM_CONTEXT_SPIKE_SLOT_SAVE_PATH;
if (!configuredRoot?.startsWith("/") || configuredRoot === "/") throw new Error("isolated slot path is required");
const root = await realpath(configuredRoot);
const length = Number(process.env.LARM_CONTEXT_SPIKE_RESTART_LENGTH ?? 8192);
const predictTokens = Number(process.env.LARM_CONTEXT_SPIKE_PREDICT_TOKENS ?? 128);
if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(predictTokens) || predictTokens < 1) {
  throw new Error("restart length and prediction count must be positive integers");
}
async function request(path: string, body?: Json): Promise<Json> {
  const response = await fetch(`${endpoint}${path}`, body ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  } : undefined);
  const value = await response.json() as Json;
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(value).slice(0, 1000)}`);
  return value;
}
const props = await request("/props");
const release = process.env.LARM_CONTEXT_SPIKE_RELEASE ?? "qwen-worker-quality-current";
const compatibilityKey = digest({
  release,
  build: props.build_info,
  model: props.model_path,
  context: (props.default_generation_settings as Json | undefined)?.n_ctx,
  cacheTypeK: "q4_0",
  cacheTypeV: "q4_0",
});
const seed = await request("/tokenize", {
  content: "Immutable virtual context record. 日本語 context boundary 0123456789.\n",
  add_special: false,
});
if (!Array.isArray(seed.tokens) || seed.tokens.length === 0) throw new Error("tokenizer probe failed");
const seedTokens = seed.tokens as number[];
const store = new LocalContextSnapshotStore(root, { maxBytes: 512 * 1024 ** 3, freeFloorBytes: 1 });
const evidencePath = process.env.LARM_CONTEXT_SPIKE_EVIDENCE;
if (evidencePath) {
  if (!evidencePath.startsWith("/") || evidencePath === "/") throw new Error("evidence path must be an absolute file");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Json;
  if (!Array.isArray(evidence.cases) || evidence.cases.length === 0) throw new Error("evidence has no cases");
  const expectedPath = process.env.LARM_CONTEXT_SPIKE_EXPECTED_RESTART;
  const expected = expectedPath
    ? JSON.parse(await readFile(expectedPath, "utf8")) as Json
    : undefined;
  const manifests: ContextSnapshotManifest[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/^ctxsnap-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    try {
      manifests.push(contextSnapshotManifestSchema.parse(JSON.parse(await readFile(`${root}/${entry.name}`, "utf8"))));
    } catch {
      // Invalid manifests are fault-injection artifacts and are intentionally ignored here.
    }
  }
  const restartCases: Json[] = [];
  for (const item of evidence.cases as Json[]) {
    const prefixTokens = Number(item.requestedPrefixTokens);
    const snapshotBytes = Number(item.snapshotBytes);
    const expectedCase = Array.isArray(expected?.cases)
      ? (expected.cases as Json[]).find((candidate) => Number(candidate.prefixTokens) === prefixTokens)
      : undefined;
    const manifest = manifests.find((candidate) =>
      candidate.principalScope === store.principalScope("m3b-isolated-conformance")
      && candidate.runtime === "qwen-worker-quality"
      && candidate.release === release
      && candidate.compatibilityKey === compatibilityKey
      && candidate.tokenCount === prefixTokens
      && candidate.snapshotBytes === snapshotBytes
    );
    if (!manifest) throw new Error(`committed snapshot for ${prefixTokens} tokens is unavailable`);
    const verified = await store.findAndVerify({
      principalScope: manifest.principalScope,
      runtime: manifest.runtime,
      release: manifest.release,
      compatibilityKey: manifest.compatibilityKey,
      viewDigest: manifest.viewDigest,
      maxBytes: 512 * 1024 ** 3,
    });
    if (!verified.hit || verified.cached) {
      throw new Error(`persisted ${prefixTokens}-token snapshot unavailable: ${verified.hit ? "cached" : verified.reason}`);
    }
    await new LlamaContextSlotAdapter().restore(endpoint, 0, verified.filename);
    const prompt = [
      ...Array.from({ length: prefixTokens }, (_, index) => seedTokens[index % seedTokens.length]),
      seedTokens[0]!,
    ];
    const generated = await request("/completion", {
      prompt,
      n_predict: Number(evidence.predictTokens),
      cache_prompt: true,
      id_slot: 0,
      temperature: 0,
      seed: 424242,
      return_tokens: true,
    });
    const actualDigest = digest(generated.tokens);
    const timings = generated.timings as Json | undefined;
    const promptProcessed = Number(timings?.prompt_n);
    const expectedDigest = expectedCase ? String(expectedCase.actualDigest) : actualDigest;
    restartCases.push({
      prefixTokens,
      snapshotBytes,
      coldVerificationMs: verified.verificationMs,
      promptProcessed,
      expectedDigest,
      actualDigest,
      exact: actualDigest === expectedDigest,
      reused: promptProcessed <= 2,
    });
  }
  const passed = restartCases.every((item) => item.exact === true && item.reused === true);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: expected ? "full-matrix-post-restart" : "full-matrix-pre-restart",
    observedAt: new Date().toISOString(),
    engineBuild: props.build_info,
    cases: restartCases,
    passed,
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 2;
  process.exit();
}
const prompt = Array.from({ length }, (_, index) => seedTokens[index % seedTokens.length]);
const viewDigest = digest({ savePoint: "response-terminal-v1", length, promptDigest: digest(prompt) });
const verified = await store.findAndVerify({
  principalScope: store.principalScope("m3b-isolated-conformance"),
  runtime: "qwen-worker-quality",
  release,
  compatibilityKey,
  viewDigest,
  maxBytes: 512 * 1024 ** 3,
});
if (!verified.hit || verified.cached) throw new Error(`persisted snapshot unavailable: ${verified.hit ? "cached" : verified.reason}`);
const slots = new LlamaContextSlotAdapter();
const fill = await request("/completion", {
  prompt,
  n_predict: 1,
  cache_prompt: false,
  id_slot: 0,
  temperature: 0,
  seed: 424242,
});
if (typeof fill.content !== "string") throw new Error("restart fill returned no content");
const suffix = await request("/tokenize", { content: fill.content, add_special: false });
if (!Array.isArray(suffix.tokens) || suffix.tokens.some((token) => !Number.isInteger(token))) {
  throw new Error("restart fill suffix could not be tokenized");
}
const basePrompt = [...prompt, ...(suffix.tokens as number[])];
const baseline = await request("/completion", {
  prompt: basePrompt,
  n_predict: predictTokens,
  cache_prompt: true,
  id_slot: 0,
  temperature: 0,
  seed: 424242,
  return_tokens: true,
});
if (!Array.isArray(baseline.tokens) || baseline.tokens.some((token) => !Number.isInteger(token))) {
  throw new Error("restart baseline returned invalid tokens");
}
const resumedPrompt = [...basePrompt, ...(baseline.tokens as number[])];
const rebuilt = await request("/completion", {
  prompt: resumedPrompt,
  n_predict: predictTokens,
  cache_prompt: true,
  id_slot: 0,
  temperature: 0,
  seed: 424242,
  return_tokens: true,
});
await slots.restore(endpoint, 0, verified.filename);
const restored = await request("/completion", {
  prompt: resumedPrompt,
  n_predict: predictTokens,
  cache_prompt: true,
  id_slot: 0,
  temperature: 0,
  seed: 424242,
  return_tokens: true,
});
const restoredDigest = digest(restored.tokens);
const rebuiltDigest = digest(rebuilt.tokens);
const promptProcessed = Number((restored.timings as Json | undefined)?.prompt_n);
const passed = restoredDigest === rebuiltDigest
  && restored.content === rebuilt.content
  && Number.isSafeInteger(promptProcessed)
  && promptProcessed <= 2;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  engineBuild: props.build_info,
  length,
  predictTokens,
  coldVerificationMs: verified.verificationMs,
  promptProcessed,
  restoredDigest,
  rebuiltDigest,
  passed,
}, null, 2)}\n`);
if (!passed) process.exitCode = 2;
