import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ConnectionTokenCodec } from "./connection-token";

const key = new Uint8Array(32).fill(3);
const payload = {
  v: 1 as const,
  epoch: "epoch-example",
  connection: "aconn_epoch-example_id",
  allocation: "alloc_epoch-example_id",
  provider: "llm",
  capability: "llm.coding",
  audience: "same-host",
  generation: 1,
  iat: 1_787_982_300,
  exp: 1_787_983_200,
};

test("connection tokens are deterministic, strict, and time bounded", () => {
  const codec = new ConnectionTokenCodec(key, () => 1_787_982_400_000);
  const token = codec.sign(payload);
  expect(codec.sign(payload)).toBe(token);
  expect(codec.verify(token)).toEqual(payload);
  expect(() => codec.verify(`${token.slice(0, -1)}A`)).toThrow(/signature/);
  expect(() => new ConnectionTokenCodec(key, () => 1_787_983_200_000).verify(token)).toThrow(/expired/);
  expect(() => new ConnectionTokenCodec(key, () => 1_787_982_299_000).verify(token)).toThrow(/not active/);
});

test("connection tokens reject signed but noncanonical or unknown payload fields", () => {
  const codec = new ConnectionTokenCodec(key, () => 1_787_982_400_000);
  const noncanonical = JSON.stringify({ ...payload, unexpected: true });
  const encoded = Buffer.from(noncanonical).toString("base64url");
  const signed = `larm_conn_v1.${encoded}`;
  const signature = createHmac("sha256", key).update(signed).digest("base64url");
  expect(() => codec.verify(`${signed}.${signature}`)).toThrow(/payload/);

  const whitespace = JSON.stringify(payload, null, 2);
  const whitespaceEncoded = Buffer.from(whitespace).toString("base64url");
  const whitespaceSigned = `larm_conn_v1.${whitespaceEncoded}`;
  const whitespaceSignature = createHmac("sha256", key).update(whitespaceSigned).digest("base64url");
  expect(() => codec.verify(`${whitespaceSigned}.${whitespaceSignature}`)).toThrow(/canonical/);
});

test("connection tokens require complete instance identity", () => {
  const codec = new ConnectionTokenCodec(key, () => 1_787_982_400_000);
  expect(() => codec.sign({ ...payload, instanceId: "pinst-a" })).toThrow(/supplied together/);
  expect(() => codec.sign({
    ...payload,
    instanceId: "pinst-a",
    instanceGeneration: 1,
  })).toThrow(/providerRevision/);
});
