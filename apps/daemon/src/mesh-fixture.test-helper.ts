/** Tiny valid, self-contained triangle GLB built in memory for storage/failure tests. */
export function meshFixtureGlb(): Buffer {
  const bin = Buffer.alloc(108); const coords = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  coords.forEach((n, i) => bin.writeFloatLE(n, i * 4));
  [0, 0, 1, 0, 0, 1, 0, 0, 1].forEach((n, i) => bin.writeFloatLE(n, 36 + i * 4));
  [0, 0, 1, 0, 0, 1].forEach((n, i) => bin.writeFloatLE(n, 72 + i * 4));
  bin.writeUInt16LE(0, 96); bin.writeUInt16LE(1, 98); bin.writeUInt16LE(2, 100);
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 108 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }, { buffer: 0, byteOffset: 72, byteLength: 24 }, { buffer: 0, byteOffset: 96, byteLength: 6 }, { buffer: 0, byteOffset: 104, byteLength: 4 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" }, { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ bufferView: 4, mimeType: "image/png" }],
  }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]), out = Buffer.alloc(12 + 8 + padded.length + 8 + bin.length);
  out.write("glTF"); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20);
  const offset = 20 + padded.length; out.writeUInt32LE(bin.length, offset); out.writeUInt32LE(0x004e4942, offset + 4); bin.copy(out, offset + 8);
  return out;
}
