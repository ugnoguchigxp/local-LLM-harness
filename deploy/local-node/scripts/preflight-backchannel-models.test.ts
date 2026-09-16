import { expect, test } from "bun:test";
import { resolveLarmActivityUrl } from "./preflight-backchannel-models";

test("preflight activity URL accepts daemon origins and advertised v1 bases", () => {
  expect(resolveLarmActivityUrl("http://127.0.0.1:9810"))
    .toBe("http://127.0.0.1:9810/v1/activity");
  expect(resolveLarmActivityUrl("https://larm.example/prefix/v1/"))
    .toBe("https://larm.example/prefix/v1/activity");
  expect(resolveLarmActivityUrl("https://larm.example/prefix"))
    .toBe("https://larm.example/prefix/v1/activity");
});

test("preflight activity URL rejects ambiguous or secret-bearing bases", () => {
  expect(() => resolveLarmActivityUrl("file:///tmp/larm"))
    .toThrow(/http or https/);
  expect(() => resolveLarmActivityUrl("https://user:secret@larm.example"))
    .toThrow(/must not contain/);
  expect(() => resolveLarmActivityUrl("https://larm.example?target=other"))
    .toThrow(/must not contain/);
});
