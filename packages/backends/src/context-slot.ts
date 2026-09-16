export class ContextSlotError extends Error {
  constructor(
    readonly code: "slot_unavailable" | "slot_response_invalid",
    message: string,
  ) {
    super(message);
    this.name = "ContextSlotError";
  }
}

export class LlamaContextSlotEraseAdapter {
  async erase(endpoint: string, slotId: number, signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(
        `${endpoint.replace(/\/$/, "")}/slots/${slotId}?action=erase`,
        { method: "POST", signal },
      );
    } catch (error) {
      throw new ContextSlotError(
        "slot_unavailable",
        `slot erase request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ContextSlotError("slot_unavailable", `slot erase returned HTTP ${response.status}`);
    }
    await response.body?.cancel().catch(() => undefined);
  }
}
