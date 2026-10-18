import { IMAGE_IMPORT_LIMITS } from "@larm/core";

export class ImageImportError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 410 | 413 | 415 | 429 | 503 | 507, message = code) { super(message); }
}

// Runs only the CPU decoder. Fresh pixels discard EXIF (including GPS), ICC,
// comments and filenames. Neither user filenames nor credentials reach Python.
const DECODER = String.raw`
import sys, json, io, warnings, resource, struct
resource.setrlimit(resource.RLIMIT_AS, (512*1024**2, 512*1024**2))
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 4000000
warnings.simplefilter('error', Image.DecompressionBombWarning)
def fail(code):
    print(json.dumps({'error': code})); sys.exit(2)
try:
    data = sys.stdin.buffer.read(16*1024**2 + 1)
    if not data or len(data) > 16*1024**2: fail('image_input_too_large')
    image = Image.open(io.BytesIO(data))
    actual = {'JPEG':'image/jpeg','PNG':'image/png','WEBP':'image/webp'}.get(image.format)
    if actual is None: fail('unsupported_image_format')
    if actual != sys.argv[2]: fail('image_mime_mismatch')
    if image.width > 2000 or image.height > 2000 or image.width*image.height > 4000000: fail('image_dimensions_exceeded')
    if getattr(image, 'n_frames', 1) != 1 or getattr(image, 'is_animated', False): fail('animated_image_unsupported')
    orientation = image.getexif().get(274, 1)
    if actual == 'image/webp' and orientation not in (None, 1): fail('webp_orientation_unsupported')
    image.verify()
    image = Image.open(io.BytesIO(data)); image.load()
    image = ImageOps.exif_transpose(image)
    alpha = 'A' in image.getbands() or 'transparency' in image.info
    image = image.convert('RGBA' if alpha else 'RGB')
    clean = Image.frombytes(image.mode, image.size, image.tobytes())
    format = 'png'
    if actual == 'image/webp':
        # Strip metadata RIFF chunks without decoding/re-encoding the VP8/VP8L
        # bitstream. Clear their VP8X flags; preserve alpha and image payload.
        if data[:4] != b'RIFF' or data[8:12] != b'WEBP' or struct.unpack('<I', data[4:8])[0] + 8 != len(data): fail('invalid_image')
        chunks = []; offset = 12
        while offset < len(data):
            if offset + 8 > len(data): fail('invalid_image')
            tag = data[offset:offset+4]; size = struct.unpack('<I', data[offset+4:offset+8])[0]
            end = offset + 8 + size + (size & 1)
            if end > len(data): fail('invalid_image')
            payload = data[offset+8:offset+8+size]
            if tag == b'VP8X':
                if size != 10: fail('invalid_image')
                payload = bytes([payload[0] & ~0x2c]) + payload[1:]
            if tag in (b'VP8X', b'VP8 ', b'VP8L', b'ALPH'):
                chunks.append(tag + struct.pack('<I', len(payload)) + payload + (b'\0' if len(payload) & 1 else b''))
            offset = end
        body = b'WEBP' + b''.join(chunks)
        output = b'RIFF' + struct.pack('<I', len(body)) + body
        format = 'webp'
    else:
        encoded = io.BytesIO(); clean.save(encoded, format='PNG')
        output = encoded.getvalue()
    if len(output) > 20*1024**2: fail('image_output_too_large')
    with open(sys.argv[1], 'xb') as f: f.write(output); f.flush(); import os; os.fsync(f.fileno())
    print(json.dumps({'width':clean.width,'height':clean.height,'hasAlpha':alpha,'bytes':len(output),'format':format}))
except (Image.DecompressionBombError, Image.DecompressionBombWarning): fail('image_dimensions_exceeded')
except MemoryError: fail('image_decode_resource_limit')
except Exception: fail('invalid_image')
`;

export type NormalizedImage = { width: number; height: number; hasAlpha: boolean; bytes: number; format: "png" | "webp" };
export type ImageNormalizer = (data: Uint8Array, mimeType: string, output: string) => Promise<NormalizedImage>;
export function pythonImageNormalizer(python: string): ImageNormalizer {
  return async (data, mimeType, output) => {
    if (data.length > IMAGE_IMPORT_LIMITS.inputBytes) throw new ImageImportError("image_input_too_large", 413);
    let process: Bun.Subprocess<Uint8Array, "pipe", "ignore">;
    try { process = Bun.spawn([python, "-I", "-c", DECODER, output, mimeType], { stdin: data, stdout: "pipe", stderr: "ignore" }); }
    catch { throw new ImageImportError("image_decoder_unavailable", 503); }
    const timer = setTimeout(() => process.kill("SIGKILL"), 30_000);
    try {
      // The trusted decoder prints one small JSON object; image bytes use a private file.
      const text = await new Response(process.stdout).text();
      const exit = await process.exited;
      if (text.length > 2048) throw new ImageImportError("image_decoder_unavailable", 503);
      let value: Record<string, unknown>;
      try { value = JSON.parse(text); } catch { throw new ImageImportError("image_decoder_unavailable", 503); }
      if (exit !== 0) {
        const code = typeof value.error === "string" ? value.error : "invalid_image";
        const status = code.includes("too_large") || code === "image_dimensions_exceeded" ? 413
          : ["unsupported_image_format", "image_mime_mismatch", "animated_image_unsupported", "webp_orientation_unsupported"].includes(code) ? 415 : 400;
        throw new ImageImportError(code, status);
      }
      if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || !Number.isInteger(value.bytes)
        || (value.format !== "png" && value.format !== "webp") || typeof value.hasAlpha !== "boolean" || Number(value.width) < 1 || Number(value.height) < 1
        || Number(value.width) > 2000 || Number(value.height) > 2000 || Number(value.bytes) > IMAGE_IMPORT_LIMITS.storedBytes) throw new ImageImportError("image_decoder_unavailable", 503);
      return value as NormalizedImage;
    } finally { clearTimeout(timer); }
  };
}
