import { expect, test } from "bun:test";
import { LarmClient } from "./index";
const id = "9bcfdd0f-d2ee-4551-8080-761c04e634cc";
test("image SDK preserves the supplied UUID, uses Control bearer and polls without resubmission", async () => {
  const requests: Request[] = [];
  const receipt = { requestId: id, status: "pending" as const, createdAt: "2026-10-18T00:00:00.000Z", expiresAt: "2026-10-25T00:00:00.000Z", statusUrl: `/v1/image-imports/${id}` };
  const client = new LarmClient({ baseUrl: "http://larm.invalid", apiToken: "control", fetch: async (input, init) => {
    requests.push(new Request(String(input), init)); return Response.json(receipt);
  } });
  expect(await client.images.import(new Blob(["pixels"], { type: "image/webp" }), id)).toEqual(receipt);
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer control"); expect(requests[0]!.headers.get("idempotency-key")).toBe(id);
  expect(requests[0]!.headers.get("content-type")).toContain("multipart/form-data"); expect((await requests[0]!.formData()).get("file")).toBeInstanceOf(File);
  expect(await client.images.receipt(id)).toEqual(receipt); expect(requests.map(v => v.method)).toEqual(["POST", "GET"]);
  const failed = new LarmClient({ baseUrl: "http://larm.invalid", fetch: async () => Response.json({ ...receipt, status: "failed", error: { code: "invalid_image", message: "invalid_image" } }, { status: 400 }) });
  await expect(failed.images.import(new Blob(["bad"], { type: "image/png" }), id)).rejects.toMatchObject({ code: "invalid_image", status: 400 });
});
