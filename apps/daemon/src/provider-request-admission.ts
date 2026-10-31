export class ProviderRequestAdmissionError extends Error {
  constructor(readonly code: "provider_draining" | "connection_inactive") {
    super(code === "provider_draining" ? "provider is draining for memory reclamation" : "allocation is no longer ready");
  }
}
