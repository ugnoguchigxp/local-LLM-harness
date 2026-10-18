import { ImageImportError } from "@larm/backends";

/** Bun's multipart File.type may be inferred from the filename instead of the
 * part header. Read the declaration from the wire; never use an extension. The
 * caller separately validates that FormData contains exactly one file part. */
export function imagePartMimeType(body: Uint8Array, contentType: string, fileBytes?: Uint8Array): string {
  const boundaries = [...contentType.matchAll(/(?:^|;)\s*boundary=(?:"([^"\r\n]{1,70})"|([^;\s\r\n]{1,70}))(?=\s*(?:;|$))/gi)];
  if (boundaries.length !== 1) throw new ImageImportError("invalid_image_multipart", 400);
  const boundary = boundaries[0]![1] ?? boundaries[0]![2]!;
  if (!/^[0-9A-Za-z'()+_,./:=? -]{1,70}$/.test(boundary) || boundary.endsWith(" ")) throw new ImageImportError("invalid_image_multipart", 400);
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const prefix = Buffer.from(`--${boundary}\r\n`);
  if (!bytes.subarray(0, prefix.length).equals(prefix)) throw new ImageImportError("invalid_image_multipart", 400);
  const end = bytes.indexOf("\r\n\r\n", prefix.length);
  if (end < 0 || end - prefix.length > 16 * 1024) throw new ImageImportError("invalid_image_multipart", 400);
  const closing = Buffer.from(`\r\n--${boundary}--`);
  const trailer = bytes.subarray(-2).equals(Buffer.from("\r\n")) ? 2 : 0;
  const contentEnd = bytes.length - closing.length - trailer;
  if (contentEnd < end + 4 || !bytes.subarray(contentEnd, contentEnd + closing.length).equals(closing)) throw new ImageImportError("invalid_image_multipart", 400);
  const payload = bytes.subarray(end + 4, contentEnd);
  if (payload.includes(Buffer.from(`\r\n--${boundary}\r\n`)) || fileBytes && !payload.equals(fileBytes)) throw new ImageImportError("invalid_image_multipart", 400);
  const lines = bytes.subarray(prefix.length, end).toString("latin1").split("\r\n");
  if (lines.some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[^\r\n]*$/.test(line))) throw new ImageImportError("invalid_image_multipart", 400);
  const declarations = lines.filter(line => /^content-type:/i.test(line));
  if (declarations.length !== 1) throw new ImageImportError("unsupported_image_format", 415);
  const mime = declarations[0]!.slice(declarations[0]!.indexOf(":") + 1).trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new ImageImportError("unsupported_image_format", 415);
  return mime;
}
