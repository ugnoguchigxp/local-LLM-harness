import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ArtifactStoreError } from "./artifact-store-errors";

export const SAFE_ARTIFACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function pathsOverlap(left: string, right: string): boolean {
  const containsOrEquals = (parent: string, child: string) => {
    const relativePath = relative(resolve(parent), resolve(child));
    return relativePath === ""
      || (relativePath !== ".."
        && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        && !isAbsolute(relativePath));
  };
  return containsOrEquals(left, right) || containsOrEquals(right, left);
}

export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const rejectAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", rejectAbort);
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ArtifactStoreError(
      "operation_cancelled",
      signal.reason instanceof Error ? signal.reason.message : "artifact operation cancelled",
    );
  }
}

export async function hashArtifactFile(
  path: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: string }).code === "ELOOP") {
      throw new ArtifactStoreError("unsafe_target", `${path} must not be a symbolic link`);
    }
    throw error;
  }
  const hasher = createHash("sha256");
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new ArtifactStoreError("unsafe_target", `${path} is not a regular file`);
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      hasher.update(buffer.subarray(0, bytesRead));
    }
    throwIfAborted(signal);
    const after = await file.stat();
    const pathAfter = await lstat(path);
    if (
      !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new ArtifactStoreError("artifact_changed", `${path} changed while it was being verified`);
    }
  } finally {
    await file.close();
  }
  return { bytes, sha256: hasher.digest("hex") };
}
