import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl, applyDictionary, parseWav, percentile, readJsonlRecovering, shuffled, speedMetrics } from "../src/lib";

function wav(samples: number[], sampleRate = 8_000): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const put = (offset: number, text: string) => bytes.set(new TextEncoder().encode(text), offset);
  put(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); put(8, "WAVE"); put(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); put(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

describe("benchmark math", () => {
  test("nearest-rank percentiles and realtime metrics", () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);
    expect(speedMetrics(500, 2)).toEqual({ rtf: 0.25, xRealtime: 4 });
  });
  test("seeded shuffle is repeatable", () => {
    expect(shuffled([1, 2, 3, 4, 5], 42)).toEqual(shuffled([1, 2, 3, 4, 5], 42));
    expect(shuffled([1, 2, 3, 4, 5], 42)).not.toEqual(shuffled([1, 2, 3, 4, 5], 43));
  });
});

test("dictionary uses NFKC, longest match, then priority", () => {
  expect(applyDictionary("ＬＡＲＭとLARM-X", [
    { surface: "LARM", reading: "ラーム", priority: 9 },
    { surface: "LARM-X", reading: "ラームエックス" },
  ])).toBe("ラームとラームエックス");
});

test("WAV metadata and silence/clipping", () => {
  const measured = parseWav(wav([0, 32767, -32768, 1000]));
  expect(measured.durationSeconds).toBe(4 / 8_000);
  expect(measured.clippingSampleRatio).toBe(0.5);
  expect(measured.silent).toBe(false);
  expect(parseWav(wav([0, 0])).silent).toBe(true);
});

test("JSONL appends and recovers only a corrupt final line", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-tts-jsonl-"));
  const path = join(root, "runs.jsonl");
  await appendJsonl(path, { id: 1 });
  await appendJsonl(path, { id: 2 });
  await writeFile(path, `${await Bun.file(path).text()}{\"id\":`);
  expect(await readJsonlRecovering(path)).toEqual({ rows: [{ id: 1 }, { id: 2 }], recoveredFinalLine: true });
});
