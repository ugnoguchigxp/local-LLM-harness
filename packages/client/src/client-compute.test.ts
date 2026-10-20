import { expect, test } from "bun:test";
import { LarmClient } from "./index";

test("compute client sends a stable key once and never retries an ambiguous POST", async () => {
  const calls: RequestInit[] = [];
  const client = new LarmClient({ baseUrl: "https://control.example.invalid", apiToken: "backend-secret", fetch: async (_url, init) => {
    calls.push(init!); throw new Error("connection lost after admission");
  } });
  await expect(client.compute.submit({ code: "result=2" }, "persistent-tool-id")).rejects.toThrow("connection lost");
  expect(calls).toHaveLength(1);
  expect(new Headers(calls[0]!.headers).get("idempotency-key")).toBe("persistent-tool-id");
  expect(new Headers(calls[0]!.headers).get("authorization")).toBe("Bearer backend-secret");
});
