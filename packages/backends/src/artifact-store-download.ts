import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { artifactFileDownloadUrl, type FileArtifactDefinition } from "@larm/core";
import { ArtifactStoreError } from "./artifact-store-errors";
import { throwIfAborted, withAbort } from "./artifact-store-safety";

export async function stageFileArtifact(input: {
  artifact: FileArtifactDefinition;
  destination: string;
  signal?: AbortSignal;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs: number;
  random: () => string;
}): Promise<{
  kind: "file";
  artifactId: string;
  revision: string;
  path: string;
  bytes: number;
  sha256: string;
}> {
  const { artifact, destination, signal } = input;
  throwIfAborted(signal);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.part-${input.random()}`;
  const abort = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => abort.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    abort.abort(new Error("artifact download timeout"));
  }, input.timeoutMs);
  timeout.unref?.();
  const cleanupAbort = () => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  };

  let response: Response;
  try {
    response = await withAbort(
      (input.fetchImpl ?? fetch)(artifactFileDownloadUrl(artifact), { signal: abort.signal }),
      abort.signal,
    );
  } catch (error) {
    cleanupAbort();
    throw new ArtifactStoreError(
      timedOut ? "download_timeout" : signal?.aborted ? "operation_cancelled" : "download_failed",
      error instanceof Error ? error.message : `artifact ${artifact.id} download failed`,
    );
  }
  if (!response.ok || !response.body) {
    cleanupAbort();
    throw new ArtifactStoreError(
      "download_failed",
      `artifact ${artifact.id} download failed with HTTP ${response.status}`,
    );
  }
  const responseLength = response.headers.get("content-length");
  if (responseLength && /^\d+$/.test(responseLength) && Number(responseLength) > artifact.bytes) {
    cleanupAbort();
    await response.body.cancel();
    throw new ArtifactStoreError(
      "size_mismatch",
      `artifact ${artifact.id} exceeds declared size ${artifact.bytes}`,
    );
  }

  let output;
  try {
    output = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    cleanupAbort();
    try {
      await response.body.cancel(error);
    } catch {
      // Preserve the staging-file error.
    }
    throw new ArtifactStoreError(
      "staging_failed",
      error instanceof Error ? error.message : `artifact ${artifact.id} staging failed`,
    );
  }
  const hasher = createHash("sha256");
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await withAbort(reader.read(), abort.signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > artifact.bytes) {
        throw new ArtifactStoreError(
          "size_mismatch",
          `artifact ${artifact.id} exceeds declared size ${artifact.bytes}`,
        );
      }
      hasher.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const { bytesWritten } = await output.write(
          chunk.value,
          offset,
          chunk.value.byteLength - offset,
        );
        if (bytesWritten <= 0) throw new Error("artifact staging write made no progress");
        offset += bytesWritten;
      }
    }
    await output.sync();
    if (abort.signal.aborted) throw abort.signal.reason;
  } catch (error) {
    cleanupAbort();
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original download or filesystem failure.
    }
    try {
      await output.close();
    } catch {
      // The temporary path is still removed below.
    }
    await rm(temporary, { force: true });
    if (abort.signal.aborted && !(error instanceof ArtifactStoreError)) {
      throw new ArtifactStoreError(
        timedOut ? "download_timeout" : "operation_cancelled",
        error instanceof Error ? error.message : `artifact ${artifact.id} download timed out`,
      );
    }
    if (error instanceof ArtifactStoreError) throw error;
    throw new ArtifactStoreError(
      "staging_failed",
      error instanceof Error ? error.message : `artifact ${artifact.id} staging failed`,
    );
  }
  try {
    await output.close();
  } catch (error) {
    cleanupAbort();
    await rm(temporary, { force: true });
    throw new ArtifactStoreError(
      "staging_failed",
      error instanceof Error ? error.message : `artifact ${artifact.id} staging failed`,
    );
  }
  cleanupAbort();

  const sha256 = hasher.digest("hex");
  if (bytes !== artifact.bytes) {
    await rm(temporary, { force: true });
    throw new ArtifactStoreError(
      "size_mismatch",
      `artifact ${artifact.id} has ${bytes} bytes; expected ${artifact.bytes}`,
    );
  }
  if (sha256 !== artifact.sha256.toLowerCase()) {
    await rm(temporary, { force: true });
    throw new ArtifactStoreError(
      "checksum_mismatch",
      `artifact ${artifact.id} SHA-256 does not match the manifest`,
    );
  }
  try {
    throwIfAborted(signal);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    if (error instanceof ArtifactStoreError) throw error;
    throw new ArtifactStoreError(
      "staging_failed",
      error instanceof Error ? error.message : `artifact ${artifact.id} staging failed`,
    );
  }
  return {
    kind: "file",
    artifactId: artifact.id,
    revision: artifact.revision,
    path: destination,
    bytes,
    sha256,
  };
}
