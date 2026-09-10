import { expect, test } from "bun:test";
import { LlamaContextSlotAdapter } from "./context-slot";

test("llama slot adapter validates save and restore counters", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push(`${init?.method} ${input}`);
    const action = new URL(input.toString()).searchParams.get("action");
    return Response.json(action === "save"
      ? { n_saved: 123, n_written: 456 }
      : { n_restored: 123, n_read: 456 });
  }) as typeof fetch;
  try {
    const adapter = new LlamaContextSlotAdapter();
    expect(await adapter.save("http://127.0.0.1:59001", 0, "pending-a.bin"))
      .toEqual({ nTokens: 123, nBytes: 456 });
    expect(await adapter.restore("http://127.0.0.1:59001", 0, "snapshot-a.bin"))
      .toEqual({ nTokens: 123, nBytes: 456 });
    expect(requests).toEqual([
      "POST http://127.0.0.1:59001/slots/0?action=save",
      "POST http://127.0.0.1:59001/slots/0?action=restore",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("llama slot adapter fails closed on invalid responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ n_saved: 0, n_written: 0 })) as unknown as typeof fetch;
  try {
    await expect(new LlamaContextSlotAdapter().save("http://127.0.0.1:59001", 0, "pending-a.bin"))
      .rejects.toMatchObject({ code: "slot_response_invalid" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
