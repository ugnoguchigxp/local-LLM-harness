/** Read the native audio.cpp PCM16 WAV contract before publishing any audio. */
export function inspectMusicWave(waveform: Uint8Array): {
  durationSeconds: number;
  sampleRateHz: number;
  channels: number;
} {
  const view = new DataView(waveform.buffer, waveform.byteOffset, waveform.byteLength);
  const text = (offset: number, length: number) => Buffer.from(waveform.subarray(offset, offset + length)).toString("latin1");
  const invalid = () => new Error("Stable Audio returned an invalid or incomplete PCM16 WAV");
  if (waveform.byteLength < 44 || text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE" || view.getUint32(4, true) + 8 !== waveform.byteLength) throw invalid();
  let format: { sampleRateHz: number; channels: number; blockAlign: number } | undefined;
  let audioBytes: number | undefined;
  for (let offset = 12; offset < waveform.byteLength;) {
    if (offset + 8 > waveform.byteLength) throw invalid();
    const kind = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    const next = end + (size % 2);
    if (next > waveform.byteLength) throw invalid();
    if (kind === "fmt ") {
      if (format || size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 14, true) !== 16) throw invalid();
      const channels = view.getUint16(start + 2, true);
      const sampleRateHz = view.getUint32(start + 4, true);
      const byteRate = view.getUint32(start + 8, true);
      const blockAlign = view.getUint16(start + 12, true);
      if (channels < 1 || channels > 2 || sampleRateHz < 8_000 || sampleRateHz > 192_000 || blockAlign !== channels * 2 || byteRate !== sampleRateHz * blockAlign) throw invalid();
      format = { channels, sampleRateHz, blockAlign };
    } else if (kind === "data") {
      if (audioBytes !== undefined) throw invalid();
      audioBytes = size;
    }
    offset = next;
  }
  if (!format || !audioBytes || audioBytes % format.blockAlign !== 0) throw invalid();
  return { durationSeconds: audioBytes / format.blockAlign / format.sampleRateHz,
    sampleRateHz: format.sampleRateHz, channels: format.channels };
}
