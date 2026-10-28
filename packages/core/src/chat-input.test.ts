import { expect, test } from "bun:test";
import { ChatInputError, chatInputPolicySchema, validateChatImages } from "./chat-input";
import { chatCompletionRequestSchema } from "./openai-contract";
import { loadRegistry } from "./registry";
import { loadAgentConnectionCatalogForRegistry } from "./agent-connection";
import { join } from "node:path";

const policy = chatInputPolicySchema.parse({});
function png(width = 384, height = 384) {
  const data = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(data);
  data.writeUInt32BE(13,8); data.write("IHDR",12); data.writeUInt32BE(width,16); data.writeUInt32BE(height,20);
  return `data:image/png;base64,${data.toString("base64")}`;
}
const message = (url = png()) => ({ role: "user", content: [{ type: "image_url", image_url: { url } }] });
const request = (messages = [message()]) => ({ model: "fixture", messages });
function errorCode(fn: () => unknown) { try { fn(); } catch (e) { if (e instanceof ChatInputError) return e.code; throw e; } return undefined; }

test("images use declared MIME, decoded dimensions and the count of all history messages", () => {
  expect(validateChatImages(request([message(), message()]), policy)).toBe(2);
  expect(() => validateChatImages(request([message()]), undefined)).toThrow(ChatInputError);
  expect(errorCode(() => validateChatImages(request([message(png(8193,2))]), policy))).toBe("image_dimensions_exceeded");
  expect(errorCode(() => validateChatImages(request([message(png(8192,8192))]), policy))).toBe("image_dimensions_exceeded");
  expect(errorCode(() => validateChatImages(request([message(png(1,8192))]), policy))).toBe("image_dimensions_exceeded");
  expect(errorCode(() => validateChatImages(request(Array.from({length:9}, () => message())), policy))).toBe("image_count_exceeded");
});
test("private URLs, invalid Base64, MIME mismatches and ignored detail are rejected", () => {
  expect(errorCode(() => validateChatImages(request([message("https://private.example/image")]), policy))).toBe("image_reference_unsupported");
  expect(errorCode(() => validateChatImages(request([message("data:image/png;base64,AAAA=")]), policy))).toBe("image_invalid");
  expect(errorCode(() => validateChatImages(request([message(png().replace("image/png","image/jpeg"))]), policy))).toBe("image_mime_mismatch");
  const img = message(); (img.content[0]!.image_url as {url:string;detail?:string}).detail = "high";
  expect(errorCode(() => validateChatImages(request([img]), policy))).toBe("image_detail_unsupported");
  expect(errorCode(() => validateChatImages(request([{...message(),role:"system"}]), policy))).toBe("image_role_unsupported");
});
test("compressed BMPs are rejected before decode and uncompressed BMP dimensions are inspected", () => {
  const data = Buffer.alloc(54); data.write("BM"); data.writeUInt32LE(40,14);data.writeInt32LE(8,18);data.writeInt32LE(-8,22);data.writeUInt16LE(24,28);
  expect(validateChatImages(request([message(`data:image/bmp;base64,${data.toString("base64")}`)]), policy)).toBe(1);
  data.writeUInt32LE(1,30);
  expect(errorCode(() => validateChatImages(request([message(`data:image/bmp;base64,${data.toString("base64")}`)]),policy))).toBe("image_format_unsupported");
});
test("public request schema permits text, image-only, ordered multi-image and tool call histories", () => {
  expect(chatCompletionRequestSchema.safeParse(request()).success).toBe(true);
  expect(chatCompletionRequestSchema.safeParse(request([message(), message()])).success).toBe(true);
  expect(chatCompletionRequestSchema.safeParse({model:"fixture",messages:[{role:"assistant",tool_calls:[{id:"call",type:"function",function:{name:"f",arguments:"{}"}}]}]}).success).toBe(true);
});
test("a profile discovers its selected runtime input contract without reviving retired selectors", () => {
  const dir=join(import.meta.dir,"../../../config/local-node"); const registry=loadRegistry(dir); const catalog=loadAgentConnectionCatalogForRegistry(dir,registry);
  for(const id of ["ornith1.5Strix-vision"]) expect(catalog.profiles.find(p=>p.id===id)!.providers.find(p=>p.name==="llm")!.chatInput?.tokenCounting.endpoint).toBe("/v1/chat/completions/input-tokens");
  expect(catalog.profiles.some(p=>p.id==="ornith1.5Strix-64k")).toBe(false);
});
