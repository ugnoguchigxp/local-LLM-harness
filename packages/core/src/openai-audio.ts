export type OpenAiTranscriptionInspection =
  | { ok: true; text: string }
  | { ok: false; reason: "invalid_transcription" };

export function inspectOpenAiTranscriptionJson(value: unknown): OpenAiTranscriptionInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "invalid_transcription" };
  }
  const transcription = value as Record<string, unknown>;
  if (typeof transcription.text !== "string") {
    return { ok: false, reason: "invalid_transcription" };
  }
  if (
    transcription.language !== undefined
    && (typeof transcription.language !== "string" || transcription.language.length === 0)
  ) {
    return { ok: false, reason: "invalid_transcription" };
  }
  if (
    transcription.duration !== undefined
    && (typeof transcription.duration !== "number"
      || !Number.isFinite(transcription.duration)
      || transcription.duration < 0)
  ) {
    return { ok: false, reason: "invalid_transcription" };
  }
  if (transcription.segments !== undefined && !Array.isArray(transcription.segments)) {
    return { ok: false, reason: "invalid_transcription" };
  }
  return { ok: true, text: transcription.text };
}

const AUDIO_MEDIA_TYPES: Record<string, ReadonlySet<string>> = {
  mp3: new Set(["audio/mpeg", "audio/mp3"]),
  opus: new Set(["audio/ogg", "audio/opus"]),
  aac: new Set(["audio/aac", "audio/mp4"]),
  flac: new Set(["audio/flac", "audio/x-flac"]),
  wav: new Set(["audio/wav", "audio/wave", "audio/x-wav"]),
  pcm: new Set(["audio/pcm", "application/octet-stream"]),
};

export function isOpenAiSpeechMediaType(mediaType: string, responseFormat?: string): boolean {
  const normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (responseFormat === undefined) return normalized.startsWith("audio/");
  const accepted = AUDIO_MEDIA_TYPES[responseFormat.toLowerCase()];
  return accepted?.has(normalized) === true;
}
