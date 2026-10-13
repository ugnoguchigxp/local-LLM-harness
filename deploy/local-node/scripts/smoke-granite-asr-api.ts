import { readFileSync, writeFileSync } from "node:fs";

const endpoint = process.env.GRANITE_SMOKE_ENDPOINT ?? "http://127.0.0.1:18089";
const root = process.env.GRANITE_SMOKE_OUTPUT_DIR ?? "/srv/ai/apps/larm-granite-trial";
const manifest = JSON.parse(readFileSync("/srv/ai/benchmarks/asr-2026-10-12/manifest.json", "utf8"));
const clips = manifest.clips as { id: string; wav: string; reference: string; group: string }[];
const model = "granite-speech-4.1-2b";
function form(audio: Uint8Array, fields: Record<string, string> = {}) {
  const body = new FormData();
  body.set("model", model);
  body.set("response_format", "json");
  body.set("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}
async function transcribe(audio: Uint8Array, fields: Record<string, string> = {}, signal?: AbortSignal) {
  const start = performance.now();
  const response = await fetch(`${endpoint}/v1/audio/transcriptions`, {
    method: "POST", body: form(audio, fields), signal: signal ?? AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  return { status: response.status, body, seconds: (performance.now() - start) / 1000 };
}
const normalize = (text: string) => text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").replaceAll("3時", "三時");
const samples = [];
for (const clip of clips) {
  const result = await transcribe(readFileSync(clip.wav));
  if (result.status !== 200) throw new Error(`${clip.id}: HTTP ${result.status} ${result.body}`);
  const decoded = JSON.parse(result.body);
  if (typeof decoded.text !== "string" || normalize(decoded.text) !== normalize(clip.reference)) {
    throw new Error(`${clip.id}: transcript differs: ${decoded.text}`);
  }
  samples.push({ id: clip.id, text: decoded.text, seconds: result.seconds });
}
const short = readFileSync(clips.find(clip => clip.group === "short")!.wav);
const long = readFileSync(clips.find(clip => clip.group === "long")!.wav);
const errors = [];
for (const [audio, fields, expected] of [
  [short, { model: "qwen3-asr-1.7b" }, 404],
  [short, { response_format: "srt" }, 400],
  [short, { prompt: "test" }, 400],
  [short, { temperature: "1" }, 400],
  [new Uint8Array(), {}, 400],
  [new TextEncoder().encode("invalid WAV"), {}, 400],
] as const) {
  const result = await transcribe(audio, fields);
  if (result.status !== expected) throw new Error(`Error contract: expected ${expected}, received ${result.status}`);
  errors.push({ fields, status: result.status });
}
const silence = Buffer.from(short);
let foundData = false;
for (let offset = 12; offset + 8 <= silence.length;) {
  const size = silence.readUInt32LE(offset + 4);
  if (offset + 8 + size > silence.length) throw new Error("Truncated WAV chunk");
  if (silence.toString("ascii", offset, offset + 4) === "data") {
    silence.fill(0, offset + 8, offset + 8 + size);
    foundData = true;
  }
  offset += 8 + size + (size % 2);
}
if (!foundData) throw new Error("WAV has no audio data");
const silent = await transcribe(silence);
if (silent.status !== 200 || JSON.parse(silent.body).text !== "") throw new Error("Silence is not an empty transcript");
const formats = [];
for (const response_format of ["text", "verbose_json"]) {
  const result = await transcribe(short, { response_format });
  if (result.status !== 200) throw new Error(`Failed format ${response_format}`);
  formats.push({ response_format, status: result.status });
}
const cancellations = [];
for (let index = 0; index < 3; index++) {
  const controller = new AbortController();
  const preview = transcribe(long, {}, controller.signal).then(() => "completed", () => "aborted");
  await Bun.sleep(100);
  controller.abort();
  if (await preview !== "aborted") throw new Error("Preview finished before cancellation; test was not exercised");
  const final = await transcribe(long);
  if (final.status !== 200 || normalize(JSON.parse(final.body).text) !== normalize(clips.find(clip => clip.group === "long")!.reference)) {
    throw new Error(`Final after cancellation: ${final.status} ${final.body}`);
  }
  cancellations.push({ finalStatus: final.status, finalSeconds: final.seconds });
}
const busy = await Promise.all([transcribe(long), transcribe(long), transcribe(long)]);
if (busy.filter(result => result.status === 429).length !== 1 || busy.filter(result => result.status === 200).length !== 2) {
  throw new Error(`Bounded queue contract: ${busy.map(result => result.status).join(",")}`);
}
const health = await (await fetch(`${endpoint}/health`)).json();
const evidence = { ok: true, endpoint, model, observedAt: new Date().toISOString(), languageFieldSent: false,
  samples, errors, silenceStatus: silent.status, formats, cancellations,
  concurrentStatuses: busy.map(result => result.status), health, productionApplied: false };
writeFileSync(`${root}/api-evidence.json`, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, samples: samples.length, cancellations, concurrentStatuses: evidence.concurrentStatuses }));
