import sharp from "sharp";
import { IMAGE_IMPORT_MAX_BYTES, IMAGE_IMPORT_MAX_DIMENSION, IMAGE_IMPORT_MAX_PIXELS } from "@larm/core";

export class ImageImportError extends Error {
  constructor(readonly code: string, message: string,
    readonly status: 400 | 409 | 410 | 413 | 415 | 422 | 500 | 507) {
    super(message);
  }
}

/** Decode to raw pixels for validation only. The caller stores the original bytes. */
export async function validateImportedWebp(bytes: Buffer, mimeType: string): Promise<{
  width: number; height: number; hasAlpha: boolean;
}> {
  if (bytes.length > IMAGE_IMPORT_MAX_BYTES) {
    throw new ImageImportError("image_too_large", "image exceeds 16 MiB", 413);
  }
  if (mimeType !== "image/webp" || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP") {
    throw new ImageImportError("unsupported_image_format", "only image/webp containing a WebP image is accepted", 415);
  }
  const corrupt = () => new ImageImportError("invalid_image", "WebP image is corrupt or incomplete", 422);
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw corrupt();
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw corrupt();
    const tag = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + length + (length % 2) > bytes.length) throw corrupt();
    if (tag === "ANIM" || tag === "ANMF" || (tag === "VP8X" && length > 0 && (bytes[offset + 8]! & 2))) {
      throw new ImageImportError("animated_image_not_supported", "animated WebP is not accepted", 415);
    }
    offset += 8 + length + (length % 2);
  }
  try {
    // Read dimensions before applying the decoder's pixel limit, so excess
    // dimensions have a stable error distinct from corrupt pixel data.
    const metadata = await sharp(bytes, { failOn: "warning", limitInputPixels: false }).metadata();
    const { width, height } = metadata;
    if (metadata.format !== "webp" || !width || !height) throw corrupt();
    if (width > IMAGE_IMPORT_MAX_DIMENSION || height > IMAGE_IMPORT_MAX_DIMENSION
      || width * height > IMAGE_IMPORT_MAX_PIXELS) {
      throw new ImageImportError("image_dimensions_exceeded", "image must be at most 2000 x 2000 and 4,000,000 pixels", 413);
    }
    if ((metadata.pages ?? 1) !== 1) {
      throw new ImageImportError("animated_image_not_supported", "animated WebP is not accepted", 415);
    }
    const decoded = await sharp(bytes, { failOn: "warning", limitInputPixels: IMAGE_IMPORT_MAX_PIXELS })
      .raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== width || decoded.info.height !== height
      || decoded.data.length !== width * height * decoded.info.channels) throw corrupt();
    return { width, height, hasAlpha: metadata.hasAlpha };
  } catch (error) {
    if (error instanceof ImageImportError) throw error;
    throw corrupt();
  }
}
