import { expect, test } from "bun:test";
import { isLiteralLoopbackHost } from "./network";

test("loopback detection accepts only literal loopback hosts", () => {
  expect(isLiteralLoopbackHost("127.0.0.1")).toBeTrue();
  expect(isLiteralLoopbackHost("127.255.0.1")).toBeTrue();
  expect(isLiteralLoopbackHost("::1")).toBeTrue();
  expect(isLiteralLoopbackHost("[::1]")).toBeTrue();
  expect(isLiteralLoopbackHost("localhost")).toBeFalse();
  expect(isLiteralLoopbackHost("127.example")).toBeFalse();
  expect(isLiteralLoopbackHost("192.0.2.1")).toBeFalse();
});
