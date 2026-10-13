import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const root = "/srv/ai/apps/larm-granite-trial";
const pid = execFileSync("systemctl", ["show", "granite-asr-trial.service", "-p", "MainPID", "--value"], { encoding: "utf8" }).trim();
if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("Granite service is not running");
const sample = readFileSync("/srv/ai/benchmarks/asr-2026-10-12/audio/l01-Kasukabe_Tsumugi.wav");
let source = Buffer.alloc(0);
for (let offset = 12; offset + 8 <= sample.length;) {
  const size = sample.readUInt32LE(offset + 4);
  if (sample.toString("ascii", offset, offset + 4) === "data") source = sample.subarray(offset + 8, offset + 8 + size);
  offset += 8 + size + size % 2;
}
if (!source.length) throw new Error("WAV fixture contains no PCM");
function wav(seconds: number) {
  const count = Math.round(seconds * 16000) * 2;
  const audio = Buffer.alloc(44 + count);
  audio.write("RIFF", 0); audio.writeUInt32LE(36 + count, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(count, 40);
  for (let offset = 44; offset < audio.length; offset += source.length) source.copy(audio, offset, 0, Math.min(source.length, audio.length - offset));
  return audio;
}
const observations: { rssKiB: number; gpuKiB: number; combinedGiB: number }[] = [];
function observe() {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const rssKiB = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]);
  const clients = new Set<string>();
  let gpuKiB = 0;
  for (const fd of readdirSync(`/proc/${pid}/fdinfo`)) {
    let info: string;
    try { info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8"); } catch { continue; }
    const client = /^drm-client-id:\s+(\d+)/m.exec(info)?.[1];
    if (!client || clients.has(client)) continue;
    clients.add(client);
    for (const kind of ["gtt", "vram"]) gpuKiB += Number(new RegExp(`^drm-memory-${kind}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? 0);
  }
  observations.push({ rssKiB, gpuKiB, combinedGiB: (rssKiB + gpuKiB) / (1024 ** 2) });
}
observe();
const timer = setInterval(observe, 20);
const results = [];
try {
  for (const duration of [12, 12, 12.01]) {
    const body = new FormData();
    body.set("model", "granite-speech-4.1-2b"); body.set("response_format", "json");
    body.set("file", new Blob([wav(duration)], { type: "audio/wav" }), "speech.wav");
    const start = performance.now();
    const response = await fetch("http://127.0.0.1:8089/v1/audio/transcriptions", { method: "POST", body, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (response.status !== (duration > 12 ? 413 : 200)) throw new Error(`Duration ${duration}: HTTP ${response.status} ${text}`);
    results.push({ duration, status: response.status, seconds: (performance.now() - start) / 1000 });
    observe();
  }
} finally { clearInterval(timer); }
const evidence = { observedAt: new Date().toISOString(), pid, results, samples: observations.length,
  peakCombinedGiB: Math.max(...observations.map(item => item.combinedGiB)),
  peakGpuGiB: Math.max(...observations.map(item => item.gpuKiB)) / (1024 ** 2),
  peakRssGiB: Math.max(...observations.map(item => item.rssKiB)) / (1024 ** 2),
  method: "20ms samples; process RSS plus DRM GTT/VRAM allocations; duplicate DRM clients counted once; only this process, not global MemAvailable delta" };
writeFileSync(`${root}/memory-evidence.json`, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
