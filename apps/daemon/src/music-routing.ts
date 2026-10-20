import { resolveMusicRoute, MusicRoutingError, STABLE_MUSIC_MODEL, STABLE_SFX_MODEL, STABLE_MAX_DURATION_SECONDS, type MusicGenerationRequest, type MusicProvider } from "@larm/core";
import { MusicProviderError } from "./music-errors";

export class RoutedMusicProvider implements MusicProvider {
  readonly id = "local-audio";
  readonly models: NonNullable<MusicProvider["models"]> = [
    { id: STABLE_MUSIC_MODEL, task: "music", maxDurationSeconds: STABLE_MAX_DURATION_SECONDS },
    { id: "acestep-v15-turbo", task: "vocals", maxDurationSeconds: 600 },
    { id: STABLE_SFX_MODEL, task: "sound-effect", maxDurationSeconds: STABLE_MAX_DURATION_SECONDS },
  ];
  readonly capabilities: MusicProvider["capabilities"];
  constructor(private readonly vocals: MusicProvider, private readonly stable: MusicProvider) {
    this.capabilities = vocals.capabilities;
  }
  private selected(request: MusicGenerationRequest) {
    try {
      const route = resolveMusicRoute(request);
      return { route, provider: route.runtime === "music" ? this.vocals : this.stable };
    } catch (error) {
      if (error instanceof MusicRoutingError) throw new MusicProviderError(error.code, error.message);
      throw error;
    }
  }
  validate(request: MusicGenerationRequest): void {
    const { route, provider } = this.selected(request);
    provider.validate?.({ ...request, model: route.model });
  }
  async load(): Promise<void> {}
  async unload(): Promise<void> { await this.vocals.unload(); await this.stable.unload(); }
  async health() {
    const [vocals, stable] = await Promise.all([this.vocals.health(), this.stable.health()]);
    return { available: vocals.available && stable.available,
      ...(!vocals.available || !stable.available ? { reason: vocals.reason ?? stable.reason ?? "audio runtime unavailable" } : {}) };
  }
  async generate(request: MusicGenerationRequest, context: Parameters<MusicProvider["generate"]>[1]) {
    const { route, provider } = this.selected(request);
    const result = await provider.generate({ ...request, model: route.model }, context);
    return { ...result, metadata: { ...result.metadata, upstreamProvider: provider.id, runtime: route.runtime } };
  }
}
