import { expect, test } from "bun:test";
import { encodeMusicOpus, verifyMusicOpusEncoder } from "./music-audio";

function floatWave(seconds = 2): Uint8Array {
  const rate = 48_000, channels = 2;
  const frames = rate * seconds;
  const wave = new Uint8Array(44 + frames * channels * 4);
  const view = new DataView(wave.buffer);
  const tag = (offset: number, value: string) => wave.set(new TextEncoder().encode(value), offset);
  tag(0, "RIFF"); view.setUint32(4, wave.length - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 4, true); view.setUint16(32, channels * 4, true);
  view.setUint16(34, 32, true); tag(36, "data"); view.setUint32(40, wave.length - 44, true);
  for (let frame = 0; frame < frames; frame++) {
    view.setFloat32(44 + frame * 8, Math.sin(frame * 2 * Math.PI * 440 / rate) * 0.2, true);
    view.setFloat32(48 + frame * 8, Math.sin(frame * 2 * Math.PI * 660 / rate) * 0.2, true);
  }
  return wave;
}

test("float WAV becomes decodable 48 kHz stereo Opus at fixed 64 kbps", async () => {
  await verifyMusicOpusEncoder();
  const audio = await encodeMusicOpus(floatWave(), new AbortController().signal, 1_000_000);
  expect(new TextDecoder().decode(audio.slice(0, 4))).toBe("OggS");
  expect(audio.length).toBeGreaterThan(16_000);
  expect(audio.length).toBeLessThan(18_000);
  const probe = Bun.spawn([
    "ffprobe", "-v", "error", "-show_streams", "-show_packets", "-of", "json", "pipe:0",
  ], { stdin: audio, stdout: "pipe", stderr: "ignore" });
  const data = await new Response(probe.stdout).json() as {
    streams: { codec_name: string; sample_rate: string; channels: number }[];
    packets: { size: string }[];
  };
  expect(await probe.exited).toBe(0);
  expect(data.streams[0]).toMatchObject({ codec_name: "opus", sample_rate: "48000", channels: 2 });
  // Each default 20 ms packet carries exactly 160 bytes at 64 kbps CBR.
  expect(new Set(data.packets.map((packet) => packet.size))).toEqual(new Set(["160"]));
});

test("Opus conversion rejects invalid input, oversize output, and cancellation", async () => {
  await expect(encodeMusicOpus(new Uint8Array([1, 2]), new AbortController().signal, 1_000_000))
    .rejects.toThrow("encoding failed");
  await expect(encodeMusicOpus(floatWave(), new AbortController().signal, 100))
    .rejects.toThrow("too large");
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await expect(encodeMusicOpus(floatWave(), abort.signal, 1_000_000)).rejects.toThrow("cancelled");
  const during = new AbortController();
  const conversion = encodeMusicOpus(floatWave(), during.signal, 1_000_000);
  during.abort(new Error("cancelled during conversion"));
  await expect(conversion).rejects.toThrow("cancelled during conversion");
});
