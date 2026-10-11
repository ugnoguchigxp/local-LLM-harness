export class MusicProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MusicProviderError";
  }
}
