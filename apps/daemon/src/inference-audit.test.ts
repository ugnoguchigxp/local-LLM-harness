import { afterEach, expect, test } from "bun:test";
import { LocalInferenceAuditStore } from "@larm/backends";
import { chmod, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileInferenceAuditRecorder,
  loadInferenceAuditKey,
} from "./inference-audit";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("file recorder stores provider-rendered prompt and token pieces", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-recorder-test-"));
  roots.push(parent);
  const store = new LocalInferenceAuditStore({
    root: join(parent, "records"),
    key: new Uint8Array(32).fill(3),
    minFreeBytes: 0,
    availableBytes: () => 1024 * 1024 * 1024,
  });
  const calls: string[] = [];
  const recorder = new FileInferenceAuditRecorder({
    store,
    fetchImpl: (async (input) => {
      calls.push(String(input));
      return String(input).endsWith("/apply-template")
        ? Response.json({ prompt: "<system>rules</system><user>hello</user>" })
        : Response.json({ tokens: [{ id: 101, piece: "<system>" }, { id: 102, piece: "rules" }] });
    }) as typeof fetch,
  });
  const session = await recorder.begin({
    requestId: "req_materialized",
    allocationId: "alloc_test",
    capability: "llm.general",
    route: "llm-default",
    runtime: "qwen-general",
    bootEpoch: "boot-test",
    configRevision: "revision-test",
    endpoint: "http://127.0.0.1:8080/",
    requestBody: new TextEncoder().encode('{"model":"local","messages":[]}'),
  });
  session.captureResponse(new TextEncoder().encode("data: [DONE]\n\n"));
  await session.finalize({ outcome: "http_200", upstreamStatus: 200 });

  const record = await store.get("req_materialized");
  expect(calls).toEqual([
    "http://127.0.0.1:8080/apply-template",
    "http://127.0.0.1:8080/tokenize",
  ]);
  expect(record.promptTokens).toBe(2);
  expect(new TextDecoder().decode(await store.readPayload(record, "prompt"))).toContain("<user>hello");
  expect(JSON.parse(new TextDecoder().decode(await store.readPayload(record, "tokens"))))
    .toEqual([{ id: 101, piece: "<system>" }, { id: 102, piece: "rules" }]);
});

test("audit key loader accepts only canonical protected 32-byte keys", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-key-test-"));
  roots.push(parent);
  const path = join(parent, "audit.key");
  const encoded = Buffer.from(new Uint8Array(32).fill(5)).toString("base64url");
  await writeFile(path, `${encoded}\n`, { mode: 0o640 });
  await chmod(path, 0o640);
  expect(await loadInferenceAuditKey(path)).toEqual(new Uint8Array(32).fill(5));
  await chmod(path, 0o644);
  await expect(loadInferenceAuditKey(path)).rejects.toThrow(/accessible by others/);
  await chmod(path, 0o640);
  await link(path, join(parent, "audit-hardlink.key"));
  await expect(loadInferenceAuditKey(path)).rejects.toThrow(/regular file/);
});

test("materialization deadline aborts a provider body that never completes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-recorder-timeout-test-"));
  roots.push(parent);
  const store = new LocalInferenceAuditStore({
    root: join(parent, "records"),
    key: new Uint8Array(32).fill(8),
    minFreeBytes: 0,
    availableBytes: () => 1024 * 1024 * 1024,
  });
  const recorder = new FileInferenceAuditRecorder({
    store,
    materializationTimeoutMs: 5,
    fetchImpl: (async () => new Response(new ReadableStream({ start() {} }))) as unknown as typeof fetch,
  });
  const startedAt = performance.now();
  const session = await recorder.begin({
    requestId: "req_materialize_timeout",
    allocationId: "alloc_test",
    capability: "llm.general",
    route: "llm-default",
    runtime: "qwen-general",
    bootEpoch: "boot-test",
    configRevision: "revision-test",
    endpoint: "http://127.0.0.1:8080",
    requestBody: new TextEncoder().encode('{"model":"local","messages":[]}'),
  });
  expect(performance.now() - startedAt).toBeLessThan(250);
  const active = await store.get("req_materialize_timeout");
  expect(active.materializationError).toContain("timed out");
  await session.finalize({ outcome: "http_504" });
});

test("operator CLI lists and verifies encrypted records", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-cli-test-"));
  roots.push(parent);
  const root = join(parent, "records");
  const keyPath = join(parent, "audit.key");
  const key = new Uint8Array(32).fill(6);
  await writeFile(keyPath, `${Buffer.from(key).toString("base64url")}\n`, { mode: 0o640 });
  await chmod(keyPath, 0o640);
  const store = new LocalInferenceAuditStore({
    root,
    key,
    minFreeBytes: 0,
    availableBytes: () => 1024 * 1024 * 1024,
  });
  const session = await store.begin({
    requestId: "req_cli",
    allocationId: "alloc_cli",
    capability: "llm.general",
    route: "llm-default",
    runtime: "qwen-general",
    bootEpoch: "boot-cli",
    configRevision: "revision-cli",
  }, new TextEncoder().encode("{}"));
  await session.finalize({ outcome: "http_200", upstreamStatus: 200 });
  const environment = {
    ...process.env,
    LARM_HOST: "127.0.0.1",
    LARM_INFERENCE_AUDIT_ROOT: root,
    LARM_INFERENCE_AUDIT_KEY_FILE: keyPath,
    LARM_INFERENCE_AUDIT_MIN_FREE_BYTES: "0",
  };
  const run = async (command: string[]) => {
    const child = Bun.spawn([
      process.execPath,
      "run",
      join(import.meta.dir, "inference-audit-cli.ts"),
      ...command,
    ], { cwd: join(import.meta.dir, "../../.."), env: environment, stderr: "pipe", stdout: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    return JSON.parse(stdout) as unknown;
  };
  expect(await run(["list"])).toEqual([
    expect.objectContaining({ requestId: "req_cli", status: "completed" }),
  ]);
  expect(await run(["verify", "req_cli"])).toEqual({ ok: true, records: 1, payloads: 1 });
});
