import { expect, test } from "bun:test";
import { countNativeTextChatInput } from "./native-text-chat-input";

const input = { endpoint: "http://fixture", request: { messages: [{ role: "user", content: "hello" }] },
  expectedImageCount: 0, engineBuild: "pinned-build", signal: new AbortController().signal, requestId: "test" };

test("native text input counting fails closed on invalid counts and bounded replies", async () => {
  for (const value of [{input_tokens:-1}, {input_tokens:1.5}, {input_tokens:"2"}, {tokens:[1,2]}]) {
    await expect(countNativeTextChatInput({ ...input, fetchImpl: async () => Response.json(value) })).rejects.toMatchObject({ code: "chat_token_count_unavailable" });
  }
  await expect(countNativeTextChatInput({ ...input, fetchImpl: async () => new Response("x".repeat(32769)) })).rejects.toMatchObject({ code: "chat_token_count_unavailable" });
  await expect(countNativeTextChatInput({ ...input, fetchImpl: async () => Response.json({input_tokens:2},{status:503}) })).rejects.toMatchObject({ code: "chat_token_count_unavailable" });
  await expect(countNativeTextChatInput({ ...input, fetchImpl: async () => { throw new Error("offline"); } })).rejects.toMatchObject({ code: "chat_token_count_unavailable" });
  await expect(countNativeTextChatInput({ ...input, fetchImpl: async () => new Response(null) })).rejects.toMatchObject({ code: "chat_token_count_unavailable" });
});

test("native text count preserves engine provenance and rejects images", async () => {
  const value = await countNativeTextChatInput({ ...input, fetchImpl: async () => Response.json({input_tokens:42}) });
  expect(value).toMatchObject({ promptTokens:42, textTokens:42, imageTokens:0, imageCount:0, engineBuild:"pinned-build" });
  await expect(countNativeTextChatInput({ ...input, expectedImageCount:1 })).rejects.toMatchObject({ code:"image_not_supported" });
  await expect(countNativeTextChatInput({ ...input, request:{messages:[{role:"user",content:[{type:"image_url",image_url:{url:"anything"}}]}]} })).rejects.toMatchObject({ code:"image_not_supported" });
});
