type SlotResult = {
  nTokens: number;
  nBytes: number;
};

export class ContextSlotError extends Error {
  constructor(
    readonly code: "slot_unavailable" | "slot_response_invalid",
    message: string,
  ) {
    super(message);
    this.name = "ContextSlotError";
  }
}

async function slotRequest(
  endpoint: string,
  slotId: number,
  action: "save" | "restore",
  filename: string,
  signal?: AbortSignal,
): Promise<SlotResult> {
  let response: Response;
  try {
    response = await fetch(
      `${endpoint.replace(/\/$/, "")}/slots/${slotId}?action=${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename }),
        signal,
      },
    );
  } catch (error) {
    throw new ContextSlotError(
      "slot_unavailable",
      `slot ${action} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.ok || mediaType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new ContextSlotError("slot_unavailable", `slot ${action} returned HTTP ${response.status}`);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ContextSlotError("slot_response_invalid", `slot ${action} returned invalid JSON`);
  }
  if (!value || typeof value !== "object") {
    throw new ContextSlotError("slot_response_invalid", `slot ${action} response is invalid`);
  }
  const record = value as Record<string, unknown>;
  const nTokens = action === "save" ? record.n_saved : record.n_restored;
  const nBytes = action === "save" ? record.n_written : record.n_read;
  if (!Number.isSafeInteger(nTokens) || (nTokens as number) < 1 || !Number.isSafeInteger(nBytes) || (nBytes as number) < 1) {
    throw new ContextSlotError("slot_response_invalid", `slot ${action} response omitted counters`);
  }
  return { nTokens: nTokens as number, nBytes: nBytes as number };
}

export class LlamaContextSlotAdapter {
  async save(
    endpoint: string,
    slotId: number,
    filename: string,
    signal?: AbortSignal,
  ): Promise<SlotResult> {
    return await slotRequest(endpoint, slotId, "save", filename, signal);
  }

  async restore(
    endpoint: string,
    slotId: number,
    filename: string,
    signal?: AbortSignal,
  ): Promise<SlotResult> {
    return await slotRequest(endpoint, slotId, "restore", filename, signal);
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
