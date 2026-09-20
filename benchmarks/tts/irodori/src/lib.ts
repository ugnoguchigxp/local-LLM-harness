import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CorpusItem = {
  id: string;
  category: string;
  display_text: string;
  spoken_text: string;
  expected_reading?: string;
};

export type WavMetrics = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frames: number;
  durationSeconds: number;
  peakDbfs: number | null;
  clippingSampleRatio: number | null;
  silent: boolean;
};

export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  if (!(fraction >= 0 && fraction <= 1)) throw new Error("percentile fraction must be within [0, 1]");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

export function speedMetrics(generationMs: number, audioSeconds: number) {
  if (!(generationMs >= 0) || !(audioSeconds > 0)) return { rtf: null, xRealtime: null };
  const generationSeconds = generationMs / 1000;
  return {
    rtf: generationSeconds / audioSeconds,
    xRealtime: audioSeconds / generationSeconds,
  };
}

export function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0 || 0x9e3779b9;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

export function applyDictionary(text: string, entries: ReadonlyArray<{ surface: string; reading: string; priority?: number }>): string {
  const normalized = text.normalize("NFKC");
  const ordered = entries.map((entry, index) => ({ ...entry, index, surface: entry.surface.normalize("NFKC") }))
    .sort((a, b) => b.surface.length - a.surface.length || (b.priority ?? 0) - (a.priority ?? 0) || a.index - b.index);
  let output = "";
  let offset = 0;
  while (offset < normalized.length) {
    const match = ordered.find((entry) => normalized.startsWith(entry.surface, offset));
    if (match) {
      output += match.reading;
      offset += match.surface.length;
    } else {
      const point = normalized.codePointAt(offset)!;
      output += String.fromCodePoint(point);
      offset += point > 0xffff ? 2 : 1;
    }
  }
  return output;
}

export function parseWav(bytes: Uint8Array): WavMetrics {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) => new TextDecoder().decode(bytes.subarray(offset, offset + length));
  if (bytes.length < 44 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") throw new Error("invalid_wav_header");
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let data: Uint8Array | undefined;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > bytes.length) throw new Error("truncated_wav_chunk");
    if (id === "fmt ") {
      if (size < 16) throw new Error("invalid_wav_fmt");
      format = {
        audioFormat: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bitsPerSample: view.getUint16(start + 14, true),
      };
    } else if (id === "data") data = bytes.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw new Error("wav_chunks_missing");
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) throw new Error("unsupported_wav_encoding");
  const sampleCount = Math.floor(data.length / 2);
  let peak = 0;
  let clipped = 0;
  const samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    const amplitude = Math.abs(samples.getInt16(index * 2, true));
    peak = Math.max(peak, amplitude);
    if (amplitude >= 32767) clipped += 1;
  }
  const frames = Math.floor(sampleCount / format.channels);
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    frames,
    durationSeconds: frames / format.sampleRate,
    peakDbfs: peak === 0 ? null : 20 * Math.log10(peak / 32768),
    clippingSampleRatio: sampleCount === 0 ? null : clipped / sampleCount,
    silent: peak <= 1,
  };
}

export async function readJsonlRecovering<T>(path: string): Promise<{ rows: T[]; recoveredFinalLine: boolean }> {
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const lines = content.split("\n");
  const rows: T[] = [];
  let recoveredFinalLine = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (error) {
      const isFinalContentLine = lines.slice(index + 1).every((candidate) => candidate.trim() === "");
      if (!isFinalContentLine) throw new Error(`invalid JSONL at line ${index + 1}`, { cause: error });
      recoveredFinalLine = true;
    }
  }
  return { rows, recoveredFinalLine };
}

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function loadCorpus(path: string): Promise<CorpusItem[]> {
  const { rows, recoveredFinalLine } = await readJsonlRecovering<CorpusItem>(path);
  if (recoveredFinalLine) throw new Error("corpus has a truncated final line");
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.id || !row.category || !row.display_text || !row.spoken_text) throw new Error("invalid corpus row");
    if (ids.has(row.id)) throw new Error(`duplicate corpus id: ${row.id}`);
    ids.add(row.id);
  }
  return rows;
}
