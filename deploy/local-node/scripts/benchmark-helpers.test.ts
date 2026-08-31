import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  consumeBenchmarkResponse,
  prepareExternalOutput,
  writeExclusive,
} from "./benchmark-helpers";

test("validates completed LLM JSON, STT JSON, and TTS attribution", async () => {
  const llm = new Response('{"choices":[{"message":{"content":"OK"}}]}', {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  expect((await consumeBenchmarkResponse("llm", llm, () => 42)).firstByteAt).toBe(42);

  const stt = new Response('{"text":"test audio"}', {
    headers: { "content-type": "application/json" },
  });
  expect((await consumeBenchmarkResponse("stt", stt)).bytes).toBeGreaterThan(0);

  const tts = new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "audio/wav", "x-voicevox-credit": "VOICEVOX" },
  });
  expect((await consumeBenchmarkResponse("tts", tts)).bytes).toBe(3);
});

test("rejects malformed successful responses", async () => {
  await expect(consumeBenchmarkResponse("llm", new Response('{"choices":[]}', {
    headers: { "content-type": "application/json" },
  }))).rejects.toThrow("llm_response_invalid");
  await expect(consumeBenchmarkResponse("llm", new Response("not-json", {
    headers: { "content-type": "application/json" },
  }))).rejects.toThrow("llm_response_invalid");
  await expect(consumeBenchmarkResponse("stt", new Response('{"text":"  "}', {
    headers: { "content-type": "application/json" },
  }))).rejects.toThrow("stt_response_invalid");
  await expect(consumeBenchmarkResponse("tts", new Response(new Uint8Array([1]), {
    headers: { "content-type": "audio/wav" },
  }))).rejects.toThrow("tts_credit_missing");
});

test("canonicalizes external evidence paths and never overwrites output", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-benchmark-helper-"));
  const repository = join(root, "repo");
  const evidence = join(root, "evidence");
  const alias = join(root, "alias");
  try {
    await mkdir(repository);
    await mkdir(evidence);
    await mkdir(join(repository, "..evidence"));
    await symlink(repository, alias);
    await expect(prepareExternalOutput(join(repository, "inside.json"), repository)).rejects.toThrow(/outside/);
    await expect(
      prepareExternalOutput(join(repository, "..evidence", "inside.json"), repository),
    ).rejects.toThrow(/outside/);
    await expect(prepareExternalOutput(join(alias, "through-link.json"), repository)).rejects.toThrow(/outside/);
    await expect(prepareExternalOutput(join(root, "missing", "raw.json"), repository)).rejects.toThrow(/already exist/);

    const output = await prepareExternalOutput(join(evidence, "raw.json"), repository);
    await writeFile(output, "existing\n", { mode: 0o600 });
    await expect(writeExclusive(output, "replacement")).rejects.toThrow(/overwrite/);
    expect(await readFile(output, "utf8")).toBe("existing\n");

    const fresh = await prepareExternalOutput(join(evidence, "summary.json"), repository);
    await writeExclusive(fresh, "evidence");
    expect(await readFile(fresh, "utf8")).toBe("evidence\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
