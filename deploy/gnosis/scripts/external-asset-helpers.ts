import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

export class ExternalAssetInspectionError extends Error {}

export async function inspectOpenedRegularFile(
  path: string,
  handle: FileHandle,
): Promise<{ bytes: number; sha256: string }> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) {
    throw new ExternalAssetInspectionError("external asset must be a regular file");
  }

  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);

  const after = await handle.stat({ bigint: true });
  const pathAfter = await lstat(path, { bigint: true });
  const openedFileChanged = before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs;
  const pathChanged = !pathAfter.isFile()
    || pathAfter.dev !== after.dev
    || pathAfter.ino !== after.ino;
  if (openedFileChanged || pathChanged) {
    throw new ExternalAssetInspectionError("external asset changed while being inspected");
  }

  return { bytes: Number(after.size), sha256: hash.digest("hex") };
}

export async function inspectRegularFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await inspectOpenedRegularFile(path, handle);
  } finally {
    await handle.close();
  }
}
