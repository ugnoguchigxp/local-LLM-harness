import { expect, test } from "bun:test";
import { responseTextLimited } from "./http";

test("bounded response reader accepts small bodies and rejects oversized bodies", async () => {
  expect(await responseTextLimited(new Response("healthy"), 16)).toBe("healthy");
  await expect(responseTextLimited(new Response("x".repeat(17)), 16)).rejects.toThrow(
    /exceeds 16 bytes/,
  );
});
