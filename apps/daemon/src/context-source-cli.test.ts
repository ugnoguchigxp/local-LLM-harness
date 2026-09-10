import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalContextSourceStore } from "@larm/backends";
import { agentPrincipal } from "./agent-connection-controller";

test("context source CLI provisions without printing source content or credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-context-cli-root-"));
  const inputRoot = await mkdtemp(join(tmpdir(), "larm-context-cli-input-"));
  const input = join(inputRoot, "source.txt");
  const apiToken = "context-cli-secret";
  const content = "private source body";
  await writeFile(input, content, { mode: 0o600 });
  const tokenizer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/props") {
        return Response.json({
          build_info: "test-build",
          chat_template: "test-template",
          default_generation_settings: { n_ctx: 262144 },
        });
      }
      if (url.pathname === "/tokenize") {
        const body = await request.json() as { content: string; with_pieces?: boolean };
        return Response.json({
          tokens: [...body.content].map((_, index) => index + 1),
          ...(body.with_pieces ? { pieces: [...body.content] } : {}),
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const child = Bun.spawn([
    process.execPath,
    "run",
    new URL("./context-source-cli.ts", import.meta.url).pathname,
    "provision",
    "policy-v1",
    input,
  ], {
    env: {
      ...Bun.env,
      LARM_API_TOKEN: apiToken,
      LARM_CONTEXT_SOURCE_ROOT: root,
      LARM_CONTEXT_SOURCE_MAX_BYTES: "1024",
      LARM_CONTEXT_SOURCE_MAX_TOTAL_BYTES: "1024",
      LARM_CONTEXT_FILESYSTEM_FREE_FLOOR_BYTES: "1",
      LARM_CONTEXT_TOKENIZER_ENDPOINT: `http://127.0.0.1:${tokenizer.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  tokenizer.stop(true);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  expect(stdout).not.toContain(content);
  expect(stdout).not.toContain(apiToken);
  const result = JSON.parse(stdout) as {
    sourceHandle: string;
    digest: string;
    bytes: number;
    tokenCount: number;
    tokenizerDigest: string;
  };
  expect(result).toMatchObject({ sourceHandle: "policy-v1", bytes: 19, tokenCount: 19 });
  expect(await new LocalContextSourceStore(root).read(
    agentPrincipal(apiToken),
    result.sourceHandle,
    result.digest,
    1024,
  )).toMatchObject({
    content,
    tokenizations: [{ tokenizerDigest: result.tokenizerDigest, tokenCount: 19 }],
  });
});
