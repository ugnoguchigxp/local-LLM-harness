import { createHash } from "node:crypto";
import { copyFile, open, realpath, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { isAbsolute, join } from "node:path";
import { LocalContextSnapshotStore, LlamaContextSlotAdapter } from "../../../packages/backends/src";

type Json = Record<string, unknown>;
type Sample = { wallMs: number; cpuMs: number };

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

async function requestJson(base: string, path: string, method: "GET" | "POST", body?: Json): Promise<Json> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return await new Promise<Json>((resolve, reject) => {
    const outgoing = request(new URL(path, base), {
      method,
      headers: payload === undefined ? undefined : {
        "content-type": "application/json",
        "content-length": String(payload.byteLength),
      },
    });
    outgoing.setTimeout(0);
    outgoing.on("error", reject);
    outgoing.on("response", (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > 16 * 1024 * 1024) response.destroy(new Error("response exceeds 16 MiB"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`${path} returned ${response.statusCode}: ${text.slice(0, 1000)}`));
          return;
        }
        try {
          const value: unknown = JSON.parse(text);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid JSON object");
          resolve(value as Json);
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.end(payload);
  });
}

async function post(base: string, path: string, body: Json): Promise<Json> {
  return await requestJson(base, path, "POST", body);
}

async function timed(run: () => Promise<unknown>): Promise<Sample> {
  const wall = performance.now();
  const cpu = process.cpuUsage();
  await run();
  const used = process.cpuUsage(cpu);
  return { wallMs: performance.now() - wall, cpuMs: (used.user + used.system) / 1_000 };
}

const endpoint = (process.env.LARM_CONTEXT_SPIKE_ENDPOINT ?? "http://127.0.0.1:59001").replace(/\/$/, "");
const configuredRoot = process.env.LARM_CONTEXT_SPIKE_SLOT_SAVE_PATH;
if (!configuredRoot || !isAbsolute(configuredRoot) || configuredRoot === "/") {
  throw new Error("LARM_CONTEXT_SPIKE_SLOT_SAVE_PATH must name the isolated absolute slot-save directory");
}
const root = await realpath(configuredRoot);
if (root === "/") throw new Error("slot-save directory must not be the filesystem root");
const lengths = (process.env.LARM_CONTEXT_SPIKE_LENGTHS ?? "8192,65536,229376")
  .split(",")
  .map((value) => positiveInteger("length", value, 0));
const repeats = positiveInteger("LARM_CONTEXT_SPIKE_REPEATS", process.env.LARM_CONTEXT_SPIKE_REPEATS, 5);
const performanceRepeats = positiveInteger(
  "LARM_CONTEXT_SPIKE_PERFORMANCE_REPEATS",
  process.env.LARM_CONTEXT_SPIKE_PERFORMANCE_REPEATS,
  20,
);
const predictTokens = positiveInteger("LARM_CONTEXT_SPIKE_PREDICT_TOKENS", process.env.LARM_CONTEXT_SPIKE_PREDICT_TOKENS, 128);
const maximumBytes = positiveInteger("LARM_CONTEXT_SPIKE_MAX_BYTES", process.env.LARM_CONTEXT_SPIKE_MAX_BYTES, 512 * 1024 ** 3);
const storeOptions = { maxBytes: maximumBytes, freeFloorBytes: 1 };
const store = new LocalContextSnapshotStore(root, storeOptions);
await store.initialize();
const slots = new LlamaContextSlotAdapter();
const props = await requestJson(endpoint, "/props", "GET");
const release = process.env.LARM_CONTEXT_SPIKE_RELEASE ?? "qwen-worker-quality-current";
const compatibilityKey = digest({
  release,
  build: props.build_info,
  model: props.model_path,
  context: (props.default_generation_settings as Json | undefined)?.n_ctx,
  cacheTypeK: "q4_0",
  cacheTypeV: "q4_0",
});
const principalScope = store.principalScope("m3b-isolated-conformance");
const seedText = "Immutable virtual context record. 日本語 context boundary 0123456789.\n";
const tokenized = await post(endpoint, "/tokenize", { content: seedText, add_special: false });
const seedTokens = tokenized.tokens;
if (!Array.isArray(seedTokens) || seedTokens.length === 0 || seedTokens.some((token) => !Number.isInteger(token))) {
  throw new Error("tokenizer returned an invalid probe sequence");
}

const cases: Json[] = [];
let largest: { filename: string; bytes: number; tokens: number; prefixTokens: number; viewDigest: string; prefillMs: number } | undefined;
for (const length of lengths) {
  const prompt = Array.from({ length }, (_, index) => seedTokens[index % seedTokens.length]);
  const fillStarted = performance.now();
  const fill = await post(endpoint, "/completion", {
    prompt,
    n_predict: 1,
    cache_prompt: false,
    id_slot: 0,
    temperature: 0,
    seed: 424242,
  });
  const prefillMs = performance.now() - fillStarted;
  if (typeof fill.content !== "string") throw new Error("fill completion returned no content");
  const suffix = await post(endpoint, "/tokenize", { content: fill.content, add_special: false });
  if (!Array.isArray(suffix.tokens) || suffix.tokens.some((token) => !Number.isInteger(token))) {
    throw new Error("fill suffix could not be tokenized");
  }
  const continuationPrompt = [...prompt, ...suffix.tokens];
  const viewDigest = digest({ savePoint: "response-terminal-v1", length, promptDigest: digest(prompt) });
  const outputs: string[] = [];
  const tokenOutputs: number[][] = [];
  const promptProcessed: number[] = [];
  const verifyRestore: Sample[] = [];
  const baseline = await post(endpoint, "/completion", {
    prompt: continuationPrompt,
    n_predict: predictTokens,
    cache_prompt: true,
    id_slot: 0,
    temperature: 0,
    seed: 424242,
    return_tokens: true,
  });
  if (typeof baseline.content !== "string" || !Array.isArray(baseline.tokens)
    || baseline.tokens.some((token) => !Number.isInteger(token))) {
    throw new Error("baseline completion returned invalid output");
  }
  const pending = store.pendingFilename();
  const saved = await slots.save(endpoint, 0, pending);
  if (saved.nTokens < prompt.length || saved.nTokens > 262_144) {
    throw new Error(`snapshot token count is outside the expected slot range: ${saved.nTokens}`);
  }
  const manifest = await store.commitPending(pending, {
    principalScope,
    runtime: "qwen-worker-quality",
    release,
    compatibilityKey,
    viewDigest,
    tokenCount: saved.nTokens,
  });
  if (manifest.snapshotBytes !== saved.nBytes) throw new Error("slot and manifest byte counts differ");
  const resumedPrompt = [...continuationPrompt, ...(baseline.tokens as number[])];
  const expectedContinuation = await post(endpoint, "/completion", {
    prompt: resumedPrompt,
    n_predict: predictTokens,
    cache_prompt: true,
    id_slot: 0,
    temperature: 0,
    seed: 424242,
    return_tokens: true,
  });
  if (typeof expectedContinuation.content !== "string" || !Array.isArray(expectedContinuation.tokens)
    || expectedContinuation.tokens.some((token) => !Number.isInteger(token))) {
    throw new Error("expected session continuation returned invalid output");
  }
  const expectation = {
    principalScope,
    runtime: "qwen-worker-quality",
    release,
    compatibilityKey,
    viewDigest,
    maxBytes: maximumBytes,
  };
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const freshStore = new LocalContextSnapshotStore(root, storeOptions);
    const verified = await freshStore.findAndVerify(expectation);
    if (!verified.hit || verified.cached) throw new Error(`snapshot verification failed: ${verified.hit ? "cached" : verified.reason}`);
    verifyRestore.push(await timed(async () => await slots.restore(endpoint, 0, verified.filename)));
    const generated = await post(endpoint, "/completion", {
      prompt: resumedPrompt,
      n_predict: predictTokens,
      cache_prompt: true,
      id_slot: 0,
      temperature: 0,
      seed: 424242,
      return_tokens: true,
    });
    if (typeof generated.content !== "string" || !Array.isArray(generated.tokens)
      || generated.tokens.some((token) => !Number.isInteger(token))) {
      throw new Error("completion returned invalid output");
    }
    outputs.push(generated.content);
    tokenOutputs.push(generated.tokens as number[]);
    const timings = generated.timings as Json | undefined;
    promptProcessed.push(Number(timings?.prompt_n));
  }
  const outputDigests = tokenOutputs.map(digest);
  const continuationDigest = digest(expectedContinuation.tokens);
  cases.push({
    requestedPrefixTokens: length,
    evaluatedPrefixTokens: fill.tokens_evaluated,
    snapshotTokens: saved.nTokens,
    snapshotBytes: saved.nBytes,
    chunkCount: manifest.chunks.length,
    prefillMs: Math.round(prefillMs),
    verifyRestoreMs: verifyRestore.map((sample) => Math.round(sample.wallMs)),
    outputDigests,
    promptProcessed,
    generatedTokenCounts: tokenOutputs.map((tokens) => tokens.length),
    savedResponseDigest: digest(baseline.tokens),
    continuationOutputDigest: continuationDigest,
    exact: new Set([...outputDigests, continuationDigest]).size === 1
      && new Set([...outputs, expectedContinuation.content]).size === 1,
    sessionPrefixReused: promptProcessed.every((count) => Number.isSafeInteger(count) && count <= 2),
  });
  if (!largest || manifest.snapshotBytes > largest.bytes) {
    largest = { filename: store.filename(manifest.entryId), bytes: manifest.snapshotBytes, tokens: saved.nTokens, prefixTokens: length, viewDigest, prefillMs };
  }
}

if (!largest) throw new Error("no snapshot was produced");

async function faultCopy(name: string) {
  const viewDigest = digest({ fault: name, source: largest!.viewDigest });
  const pending = store.pendingFilename();
  await copyFile(join(root, largest!.filename), join(root, pending));
  const manifest = await store.commitPending(pending, {
    principalScope,
    runtime: "qwen-worker-quality",
    release,
    compatibilityKey,
    viewDigest,
    tokenCount: largest!.tokens,
  });
  return {
    filename: store.filename(manifest.entryId),
    expectation: { principalScope, runtime: "qwen-worker-quality", release, compatibilityKey, viewDigest, maxBytes: maximumBytes },
  };
}

const faults: Json[] = [];
for (const kind of ["single-bit", "multi-bit", "truncate", "chunk-drop", "chunk-reorder"] as const) {
  const fault = await faultCopy(kind);
  const path = join(root, fault.filename);
  const metadata = await stat(path);
  if (kind === "truncate") {
    await truncate(path, metadata.size - 1);
  } else if (kind === "chunk-drop") {
    if (metadata.size <= 64 * 1024 ** 2) throw new Error("chunk drop probe requires two chunks");
    await truncate(path, metadata.size - 64 * 1024 ** 2);
  } else if (kind === "chunk-reorder") {
    if (metadata.size <= 64 * 1024 ** 2) throw new Error("chunk reorder probe requires two chunks");
    const handle = await open(path, "r+");
    try {
      const left = Buffer.allocUnsafe(1024 * 1024);
      const right = Buffer.allocUnsafe(1024 * 1024);
      if ((await handle.read(left, 0, left.length, 0)).bytesRead !== left.length
        || (await handle.read(right, 0, right.length, 64 * 1024 ** 2)).bytesRead !== right.length) {
        throw new Error("chunk reorder read failed");
      }
      await handle.write(right, 0, right.length, 0);
      await handle.write(left, 0, left.length, 64 * 1024 ** 2);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    const handle = await open(path, "r+");
    try {
      const offsets = kind === "single-bit" ? [Math.floor(metadata.size / 2)] : [1, Math.floor(metadata.size / 2), metadata.size - 2];
      for (const offset of offsets) {
        const byte = Buffer.alloc(1);
        if ((await handle.read(byte, 0, 1, offset)).bytesRead !== 1) throw new Error("fault byte read failed");
        byte[0] ^= kind === "single-bit" ? 0x01 : 0xa5;
        if ((await handle.write(byte, 0, 1, offset)).bytesWritten !== 1) throw new Error("fault byte write failed");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const result = await new LocalContextSnapshotStore(root, storeOptions).findAndVerify(fault.expectation);
  faults.push({ kind, rejectedBeforeRestore: !result.hit, reason: result.hit ? "accepted" : result.reason });
}

for (const kind of ["missing-manifest", "invalid-manifest"] as const) {
  const fault = await faultCopy(kind);
  const manifestPath = join(root, fault.filename.replace(/\.bin$/, ".json"));
  if (kind === "missing-manifest") await unlink(manifestPath);
  else await writeFile(manifestPath, "{\"schemaVersion\":0}\n");
  const result = await new LocalContextSnapshotStore(root, storeOptions).findAndVerify(fault.expectation);
  faults.push({ kind, rejectedBeforeRestore: !result.hit, reason: result.hit ? "accepted" : result.reason });
}

const identityFaults = [
  { kind: "wrong-release", patch: { release: `${release}-stale` } },
  { kind: "wrong-runtime", patch: { runtime: "qwen-general" } },
  { kind: "wrong-principal", patch: { principalScope: digest("other-principal") } },
  { kind: "wrong-engine-fence", patch: { compatibilityKey: digest("stale-engine") } },
] as const;
for (const fault of identityFaults) {
  const result = await new LocalContextSnapshotStore(root, storeOptions).findAndVerify({
    principalScope,
    runtime: "qwen-worker-quality",
    release,
    compatibilityKey,
    viewDigest: largest.viewDigest,
    maxBytes: maximumBytes,
    ...fault.patch,
  });
  faults.push({ kind: fault.kind, rejectedBeforeRestore: !result.hit, reason: result.hit ? "accepted" : result.reason });
}

const rawSamples: Sample[] = [];
const coldProtectedSamples: Sample[] = [];
const warmProtectedSamples: Sample[] = [];
const warmStore = new LocalContextSnapshotStore(root, storeOptions);
const performanceExpectation = {
  principalScope,
  runtime: "qwen-worker-quality",
  release,
  compatibilityKey,
  viewDigest: largest.viewDigest,
  maxBytes: maximumBytes,
};
const primed = await warmStore.findAndVerify(performanceExpectation);
if (!primed.hit || primed.cached) throw new Error("warm performance snapshot could not be primed");
for (let repeat = 0; repeat < performanceRepeats; repeat += 1) {
  rawSamples.push(await timed(async () => await slots.restore(endpoint, 0, largest!.filename)));
  coldProtectedSamples.push(await timed(async () => {
    const fresh = new LocalContextSnapshotStore(root, storeOptions);
    const verified = await fresh.findAndVerify(performanceExpectation);
    if (!verified.hit || verified.cached) throw new Error("performance snapshot was not fully verified");
    await slots.restore(endpoint, 0, verified.filename);
  }));
  warmProtectedSamples.push(await timed(async () => {
    const verified = await warmStore.findAndVerify(performanceExpectation);
    if (!verified.hit || !verified.cached) throw new Error("performance snapshot did not use verified identity");
    await slots.restore(endpoint, 0, verified.filename);
  }));
}
const rawP95 = percentile(rawSamples.map((sample) => sample.wallMs), 0.95);
const coldProtectedP95 = percentile(coldProtectedSamples.map((sample) => sample.wallMs), 0.95);
const warmProtectedP95 = percentile(warmProtectedSamples.map((sample) => sample.wallMs), 0.95);
const prefillP95 = Math.max(...cases.map((item) => Number(item.prefillMs)));
const performanceSummary = {
  snapshotBytes: largest.bytes,
  bytesPerPrefixToken: largest.bytes / largest.prefixTokens,
  estimated20MTokensBytes: Math.ceil(largest.bytes / largest.prefixTokens * 20_000_000),
  estimated20MTokensGiB: largest.bytes / largest.prefixTokens * 20_000_000 / 1024 ** 3,
  rawRestore: { p50Ms: percentile(rawSamples.map((sample) => sample.wallMs), 0.5), p95Ms: rawP95, cpuMs: rawSamples.map((sample) => sample.cpuMs) },
  coldCrcVerifyAndRestore: { p50Ms: percentile(coldProtectedSamples.map((sample) => sample.wallMs), 0.5), p95Ms: coldProtectedP95, cpuMs: coldProtectedSamples.map((sample) => sample.cpuMs) },
  warmVerifiedRestore: { p50Ms: percentile(warmProtectedSamples.map((sample) => sample.wallMs), 0.5), p95Ms: warmProtectedP95, cpuMs: warmProtectedSamples.map((sample) => sample.cpuMs) },
  warmOverheadRatio: warmProtectedP95 / rawP95,
  coldPrefillRatio: coldProtectedP95 / prefillP95,
};
const gates = {
  exact: cases.every((item) => item.exact === true),
  sessionPrefixReuse: cases.every((item) => item.sessionPrefixReused === true),
  faultRejection: faults.every((item) => item.rejectedBeforeRestore === true),
  warmRestoreOverhead: warmProtectedP95 <= rawP95 * 1.1,
  coldPrefillAdvantage: coldProtectedP95 <= prefillP95 * 0.8,
};
const passed = Object.values(gates).every(Boolean);
process.stdout.write(`${JSON.stringify({
  schemaVersion: 2,
  observedAt: new Date().toISOString(),
  endpoint,
  engineBuild: props.build_info,
  modelPath: props.model_path,
  contextLimitTokens: (props.default_generation_settings as Json | undefined)?.n_ctx,
  cacheTypeK: "q4_0",
  cacheTypeV: "q4_0",
  predictTokens,
  repeats,
  performanceRepeats,
  cases,
  faults,
  performance: performanceSummary,
  gates,
  passed,
}, null, 2)}\n`);
if (!passed) process.exitCode = 2;
