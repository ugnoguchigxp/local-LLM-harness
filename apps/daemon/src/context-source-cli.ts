import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { LlamaContextTokenizer, LocalContextSourceStore } from "@larm/backends";
import { agentPrincipal } from "./agent-connection-controller";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function boundedBytes(raw: string | undefined): number {
  const value = raw === undefined ? 256 * 1024 * 1024 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2 * 1024 * 1024 * 1024) {
    fail("LARM_CONTEXT_SOURCE_MAX_BYTES must be an integer from 1 through 2147483648");
  }
  return value;
}

function boundedCapacity(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2 * 1024 ** 4) {
    fail(`${name} must be an integer from 1 through ${2 * 1024 ** 4}`);
  }
  return value;
}

async function readSafeUtf8(pathInput: string, maxBytes: number): Promise<string> {
  const path = resolve(pathInput);
  const metadata = await lstat(path).catch(() => fail(`source file not found: ${path}`));
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(path) !== path) {
    fail("source path must be a canonical regular file, not a symbolic link");
  }
  if (metadata.size > maxBytes) fail(`source file exceeds ${maxBytes} bytes`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      fail("source file changed while it was being opened");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) fail(`source file exceeds ${maxBytes} bytes`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("source file must be valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

const [command, sourceHandle, sourcePath] = process.argv.slice(2);
if (command !== "provision" || !sourceHandle || !sourcePath || process.argv.length !== 5) {
  fail("usage: bun run context:source:provision provision <source-handle> <absolute-source-file>");
}
if (!sourcePath.startsWith("/")) fail("source file path must be absolute");
const apiToken = process.env.LARM_API_TOKEN;
if (!apiToken) fail("LARM_API_TOKEN is required to derive the isolated principal scope");

const root = process.env.LARM_CONTEXT_SOURCE_ROOT ?? "/srv/ai/context-sources";
const maxBytes = boundedBytes(process.env.LARM_CONTEXT_SOURCE_MAX_BYTES);
const content = await readSafeUtf8(sourcePath, maxBytes);
const sourceQuota = boundedCapacity(
  process.env.LARM_CONTEXT_SOURCE_MAX_TOTAL_BYTES,
  512 * 1024 ** 3,
  "LARM_CONTEXT_SOURCE_MAX_TOTAL_BYTES",
);
const freeFloor = boundedCapacity(
  process.env.LARM_CONTEXT_FILESYSTEM_FREE_FLOOR_BYTES,
  256 * 1024 ** 3,
  "LARM_CONTEXT_FILESYSTEM_FREE_FLOOR_BYTES",
);
const tokenizerEndpoint = process.env.LARM_CONTEXT_TOKENIZER_ENDPOINT ?? "http://127.0.0.1:8080";
let parsedEndpoint: URL;
try {
  parsedEndpoint = new URL(tokenizerEndpoint);
} catch {
  fail("LARM_CONTEXT_TOKENIZER_ENDPOINT must be an absolute URL");
}
if (parsedEndpoint.protocol !== "http:" || parsedEndpoint.hostname !== "127.0.0.1") {
  fail("LARM_CONTEXT_TOKENIZER_ENDPOINT must use http://127.0.0.1");
}
const tokenizer = new LlamaContextTokenizer();
const timeout = AbortSignal.timeout(600_000);
const tokenizerIdentity = await tokenizer.identity(parsedEndpoint.toString(), timeout);
const tokenCount = await tokenizer.countSourceTokens(parsedEndpoint.toString(), content, timeout);
const store = new LocalContextSourceStore(root);
const result = await store.provisionGuarded(
  agentPrincipal(apiToken),
  sourceHandle,
  content,
  {
    maxSourceBytes: maxBytes,
    maxTotalBytes: sourceQuota,
    filesystemFreeFloorBytes: freeFloor,
    tokenizations: [{ tokenizerDigest: tokenizerIdentity.tokenizerDigest, tokenCount }],
  },
);
process.stdout.write(`${JSON.stringify({
  sourceHandle,
  ...result,
  tokenizerDigest: tokenizerIdentity.tokenizerDigest,
  tokenCount,
})}\n`);
