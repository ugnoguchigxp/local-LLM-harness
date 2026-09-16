import { expect, test } from "bun:test";
import { LlamaContextSlotEraseAdapter } from "./context-slot";

test("llama slot erase adapter clears the live runtime slot", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; method?: string } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = { url: input.toString(), method: init?.method };
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  try {
    await new LlamaContextSlotEraseAdapter().erase("http://127.0.0.1:59001", 0);
    expect(request).toEqual({
      url: "http://127.0.0.1:59001/slots/0?action=erase",
      method: "POST",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("llama slot erase adapter fails closed when the runtime rejects cleanup", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  try {
    await expect(new LlamaContextSlotEraseAdapter().erase("http://127.0.0.1:59001", 0))
      .rejects.toMatchObject({ code: "slot_unavailable" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
