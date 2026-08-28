export async function responseTextLimited(response: Response, maxBytes = 64 * 1024): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel(new Error("response body exceeds limit"));
      } catch {
        // Preserve the deterministic size-limit error.
      }
      throw new Error(`response body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
