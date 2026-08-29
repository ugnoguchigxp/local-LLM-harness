import { randomUUID } from "node:crypto";
import { chmod, link, lstat, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type BenchmarkResponseKind = "llm" | "stt" | "tts";

const MAX_VALIDATED_TEXT_BYTES = 4 * 1024 * 1024;

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

export function absoluteOutput(name: string, value: string | undefined): string {
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute repository-external path`);
  }
  return resolve(value);
}

export async function prepareExternalOutput(path: string, repositoryRoot: string): Promise<string> {
  const resolvedPath = resolve(path);
  const resolvedRepository = resolve(repositoryRoot);
  if (isInside(resolvedRepository, resolvedPath)) {
    throw new Error("benchmark output must stay outside the repository");
  }
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(resolvedPath));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("benchmark output parent must already exist outside the repository");
    }
    throw cause;
  }
  const canonicalRepository = await realpath(resolvedRepository);
  const canonicalTarget = join(canonicalParent, basename(resolvedPath));
  if (isInside(canonicalRepository, canonicalTarget)) {
    throw new Error("benchmark output must stay outside the repository, including through symlinks");
  }
  try {
    await lstat(canonicalTarget);
    throw new Error(`refusing to overwrite existing benchmark output: ${canonicalTarget}`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  return canonicalTarget;
}

export async function writeExclusive(path: string, value: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${value}\n`, { flag: "wx", mode: 0o600 });
  try {
    await chmod(temporary, 0o600);
    await link(temporary, path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`refusing to overwrite existing benchmark output: ${path}`);
    }
    throw cause;
  } finally {
    await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    });
  }
}

export async function consumeBenchmarkResponse(
  kind: BenchmarkResponseKind,
  response: Response,
  now: () => number = () => performance.now(),
): Promise<{ firstByteAt: number; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response_body_missing");
  let firstByteAt: number | undefined;
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value.byteLength > 0) firstByteAt ??= now();
    bytes += chunk.value.byteLength;
    if (kind !== "tts") {
      if (bytes > MAX_VALIDATED_TEXT_BYTES) throw new Error("response_too_large");
      chunks.push(chunk.value);
    }
  }
  if (!response.ok) throw new Error(`http_${response.status}`);
  if (firstByteAt === undefined || bytes === 0) throw new Error("empty_response");

  if (kind === "tts") {
    if (!response.headers.get("content-type")?.startsWith("audio/")) throw new Error("tts_content_type_invalid");
    if (!response.headers.has("x-voicevox-credit")) throw new Error("tts_credit_missing");
    return { firstByteAt, bytes };
  }

  const body = new TextDecoder("utf-8", { fatal: true }).decode(concatenate(chunks, bytes));
  if (kind === "stt") {
    if (!response.headers.get("content-type")?.startsWith("application/json")) throw new Error("stt_content_type_invalid");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("stt_response_invalid");
    }
    if (
      typeof parsed !== "object" || parsed === null || !("text" in parsed)
      || typeof parsed.text !== "string" || parsed.text.trim().length === 0
    ) {
      throw new Error("stt_response_invalid");
    }
    return { firstByteAt, bytes };
  }

  if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
    throw new Error("llm_content_type_invalid");
  }
  const events = body.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  if (events.at(-1) !== "[DONE]") throw new Error("llm_stream_incomplete");
  const payloads = events.slice(0, -1);
  if (payloads.length === 0) throw new Error("llm_stream_empty");
  try {
    for (const payload of payloads) {
      const parsed = JSON.parse(payload);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("invalid event");
      }
    }
  } catch {
    throw new Error("llm_stream_invalid");
  }
  return { firstByteAt, bytes };
}

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
