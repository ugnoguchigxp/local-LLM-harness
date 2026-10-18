import { expect, test } from "bun:test";
import { imagePartMimeType } from "./image-import-multipart";
test("image MIME parser reads bounded single part headers, rejects ambiguity without reading filenames", () => {
  const body = (headers: string) => Buffer.from(`--a\r\n${headers}\r\n\r\npixels\r\n--a--\r\n`);
  const headers = 'Content-Disposition: form-data; name="file"; filename="private.jpg"\r\nContent-Type: image/webp';
  expect(imagePartMimeType(body(headers), 'multipart/form-data; boundary="a"')).toBe("image/webp");
  expect(() => imagePartMimeType(body(headers), "multipart/form-data; boundary=a", Buffer.from("other"))).toThrow();
  expect(imagePartMimeType(body(headers), "multipart/form-data; boundary=a", Buffer.from("pixels"))).toBe("image/webp");
  expect(() => imagePartMimeType(Buffer.from(`--a\r\n${headers}\r\n\r\npixels\r\n--a\r\nContent-Type: image/webp\r\n\r\npixels\r\n--a--\r\n`), "multipart/form-data; boundary=a")).toThrow();
  for (const type of ['multipart/form-data', 'multipart/form-data; boundary=a; boundary=b', 'multipart/form-data; boundary="a "', 'multipart/form-data; boundary=b']) expect(() => imagePartMimeType(body(headers), type)).toThrow();
  for (const part of ['Content-Type: image/webp\r\nContent-Type: image/png', 'Content-Type: image/svg+xml', 'Content-Disposition: form-data; name="file"', ' Content-Type: image/webp', 'broken header', 'X-Long: '+"x".repeat(17000)+'\r\nContent-Type: image/webp']) expect(() => imagePartMimeType(body(part), 'multipart/form-data; boundary=a')).toThrow();
});
