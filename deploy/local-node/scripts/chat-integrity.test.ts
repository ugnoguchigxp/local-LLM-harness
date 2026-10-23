import { expect, test } from "bun:test";
import { instructionPlacements } from "./chat-integrity-fixtures";
import { repairInstructionTemplate } from "./prepare-instruction-template";
import { countLlamaChatInput } from "../../../packages/backends/src/chat-input-tokenizer";

test("five fixed placements preserve the reference and only supported templates can count them", async () => {
  const fixture = instructionPlacements();
  expect(fixture.document.length).toBeGreaterThan(8000);
  const baselineSupport = [true, false, true, false, true];
  for (const [index, messages] of Object.values(fixture.cases).entries()) {
    expect(messages.filter(m => m.content.includes(fixture.document))).toHaveLength(1);
    for (const repaired of [false, true]) {
      const request = { model: "fixture", messages };
      let counted = false;
      const result = countLlamaChatInput({ endpoint: "http://fixture", request, expectedImageCount: 0, requestId: "synthetic", signal: new AbortController().signal,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init?.body));
          if (url.endsWith("/apply-template")) {
            const rendered = body.messages.filter((m: { role: string }, i: number) => repaired || m.role !== "system" || i < 2);
            return Response.json({ prompt: rendered.map((m: { content: string }) => m.content).join("\n") });
          }
          counted = true;
          expect(body).toEqual(request);
          return Response.json({ contractVersion: "llama-chat-token-count.v1", promptTokens: 2000, textTokens: 2000, imageTokens: 0, imageCount: 0, engineBuild: "fixture" });
        } });
      if (repaired || baselineSupport[index]) {
        expect((await result).promptTokens).toBe(2000); expect(counted).toBe(true);
      } else {
        await expect(result).rejects.toMatchObject({ code: "chat_instruction_template_unsupported", status: 422 });
        expect(counted).toBe(false);
      }
    }
  }
});

test("template repair refuses unknown model templates instead of rewriting them heuristically", () => {
  expect(() => repairInstructionTemplate("unknown template")).toThrow("instruction_template_source_mismatch");
});
