// Keep both sides of the conversion in pipes; no daemon-side intermediate files.
export async function verifyMusicOpusEncoder(): Promise<void> {
  const child = Bun.spawn(["ffmpeg", "-hide_banner", "-encoders"], {
    stdout: "pipe", stderr: "ignore", timeout: 10_000,
  });
  const [encoders, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0 || !/\blibopus\b/.test(encoders)) {
    throw new Error("music Opus output requires ffmpeg with the libopus encoder");
  }
}

export async function encodeMusicOpus(
  waveform: Uint8Array,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array> {
  return encodeMusicAudio(waveform, "opus", signal, maxBytes);
}

export async function encodeMusicAudio(
  waveform: Uint8Array,
  format: "opus" | "mp3" | "flac",
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const codec = format === "opus" ? ["-c:a", "libopus", "-b:a", "128k", "-vbr", "on", "-application", "audio", "-ar", "48000", "-f", "opus"]
    : format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"]
    : ["-c:a", "flac", "-f", "flac"];
  const child = Bun.spawn([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "wav", "-i", "pipe:0", "-map", "0:a:0", "-map_metadata", "-1",
    ...codec, "pipe:1",
  ], {
    stdin: waveform, stdout: "pipe", stderr: "ignore", signal, timeout: 120_000,
  });
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("encoded music audio is too large");
      chunks.push(value);
    }
    const code = await child.exited;
    signal.throwIfAborted();
    if (code !== 0 || bytes === 0) throw new Error(`music ${format} encoding failed`);
    const audio = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
    return audio;
  } finally {
    child.kill();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await child.exited;
  }
}
