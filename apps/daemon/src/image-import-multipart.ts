import busboy from "busboy";
import { IMAGE_IMPORT_MAX_BYTES } from "@larm/core";
import { ImageImportError } from "./image-import-validation";

/** Preserve the declared part MIME; Bun's FormData parser infers it from filenames. */
export function parseImageMultipart(body: Uint8Array, contentType: string): Promise<{ bytes: Buffer; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const invalid = () => new ImageImportError("invalid_multipart", "multipart/form-data must contain exactly one file field and no other fields", 400);
    let parser: ReturnType<typeof busboy>;
    try {
      parser = busboy({ headers: { "content-type": contentType },
        limits: { files: 1, fields: 0, parts: 2, fileSize: IMAGE_IMPORT_MAX_BYTES + 1, headerPairs: 16 } });
    } catch { reject(invalid()); return; }
    let failure: ImageImportError | undefined;
    let mimeType: string | undefined;
    let total = 0;
    const chunks: Buffer[] = [];
    parser.on("file", (name, file, info) => {
      if (name !== "file") failure = invalid();
      mimeType = info.mimeType;
      file.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > IMAGE_IMPORT_MAX_BYTES) failure = new ImageImportError("image_too_large", "image exceeds 16 MiB", 413);
        if (!failure) chunks.push(chunk);
      });
      file.on("limit", () => { failure = new ImageImportError("image_too_large", "image exceeds 16 MiB", 413); });
      file.on("error", () => { failure = invalid(); });
    });
    for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const) {
      parser.on(event, () => { failure = invalid(); });
    }
    parser.on("error", () => { failure = invalid(); });
    parser.on("close", () => {
      if (failure || !mimeType) reject(failure ?? invalid());
      else resolve({ bytes: Buffer.concat(chunks, total), mimeType });
    });
    parser.end(body);
  });
}
