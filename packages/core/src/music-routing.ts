import type { MusicGenerationRequest } from "./music";

export class MusicRoutingError extends Error {
  constructor(readonly code: "invalid_music_model" | "unsupported_feature", message: string) { super(message); }
}

export const STABLE_MUSIC_MODEL = "stable-audio-3-small-music";
export const STABLE_SFX_MODEL = "stable-audio-3-small-sfx";
export const STABLE_MAX_DURATION_SECONDS = 120;

export const MUSIC_ROUTING_MODELS: readonly string[] = ["auto", "ace-step-1.5", "acestep-v15-turbo", STABLE_MUSIC_MODEL, STABLE_SFX_MODEL];

/** Legacy ACE model names are service aliases; the requested task selects the runtime. */
export function resolveMusicRoute(request: MusicGenerationRequest): { runtime: "music" | "stable-audio"; model: string } {
  const model = request.model;
  if (model && !MUSIC_ROUTING_MODELS.includes(model)) {
    throw new MusicRoutingError("invalid_music_model", "unsupported music model; XL is not available");
  }
  const sfx = request.task === "sound-effect" || model === STABLE_SFX_MODEL;
  if (sfx) {
    if (request.lyrics?.trim() || model === STABLE_MUSIC_MODEL || (request.task === "music" && model === STABLE_SFX_MODEL)) {
      throw new MusicRoutingError("unsupported_feature", "sound effects cannot be combined with lyrics or a conflicting music model");
    }
    return { runtime: "stable-audio", model: STABLE_SFX_MODEL };
  }
  if (!request.instrumental || request.lyrics?.trim()) {
    if (model === STABLE_MUSIC_MODEL) throw new MusicRoutingError("unsupported_feature", "vocal requests require automatic model selection (ACE-Step Normal)");
    return { runtime: "music", model: "acestep-v15-turbo" };
  }
  return { runtime: "stable-audio", model: STABLE_MUSIC_MODEL };
}
