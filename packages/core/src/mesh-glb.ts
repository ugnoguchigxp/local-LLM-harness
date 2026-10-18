import { meshGeometrySchema } from "./mesh";

/** Validate the self-contained glTF container before publishing it. */
export function inspectMeshGlb(data: Buffer) {
  if (data.length < 28 || data.length > 256 * 1024 ** 2 || data.toString("ascii", 0, 4) !== "glTF"
    || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) throw new Error("invalid GLB header");
  let offset = 12, json: any, binaryLength = 0, binaryOffset = 0;
  while (offset < data.length) {
    if (offset + 8 > data.length) throw new Error("truncated GLB chunk");
    const length = data.readUInt32LE(offset), kind = data.readUInt32LE(offset + 4);
    if (length % 4 || offset + 8 + length > data.length) throw new Error("invalid GLB chunk length");
    if (kind === 0x4e4f534a) {
      if (json || offset !== 12 || length > 8 * 1024 ** 2) throw new Error("invalid GLB JSON chunk");
      json = JSON.parse(data.toString("utf8", offset + 8, offset + 8 + length).trim());
    } else if (kind === 0x004e4942) { if (binaryLength) throw new Error("duplicate GLB binary"); binaryLength = length; binaryOffset = offset + 8; }
    offset += 8 + length;
  }
  if (!json || json.asset?.version !== "2.0" || json.buffers?.length !== 1 || json.buffers[0].uri
    || !Number.isSafeInteger(json.buffers[0].byteLength) || json.buffers[0].byteLength > binaryLength) throw new Error("GLB must embed its buffer");
  const views = json.bufferViews ?? [], accessors = json.accessors ?? [];
  for (const v of views) if (v.buffer !== 0 || !Number.isSafeInteger(v.byteLength) || v.byteLength < 0
    || !Number.isSafeInteger(v.byteOffset ?? 0) || (v.byteOffset ?? 0) < 0 || (v.byteOffset ?? 0) + v.byteLength > json.buffers[0].byteLength) throw new Error("invalid GLB buffer view");
  for (const a of accessors) {
    const v = views[a.bufferView], unit = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[a.componentType];
    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>)[a.type];
    if (!v || !unit || !components || (v.byteStride !== undefined && (!Number.isSafeInteger(v.byteStride) || v.byteStride < unit * components || v.byteStride > 252)) || a.sparse || !Number.isSafeInteger(a.count) || a.count < 1
      || !Number.isSafeInteger(a.byteOffset ?? 0) || (a.byteOffset ?? 0) < 0
      || (a.byteOffset ?? 0) + (a.count - 1) * (v.byteStride ?? unit * components) + unit * components > v.byteLength) throw new Error("invalid GLB accessor");
  }
  let vertices = 0, triangles = 0;
  for (const mesh of json.meshes ?? []) for (const p of mesh.primitives ?? []) {
    const pos = accessors[p.attributes?.POSITION], norm = accessors[p.attributes?.NORMAL], uv = accessors[p.attributes?.TEXCOORD_0], idx = accessors[p.indices];
    if ((p.mode ?? 4) !== 4 || !pos || !norm || !uv || pos.type !== "VEC3" || pos.componentType !== 5126
      || norm.type !== "VEC3" || norm.componentType !== 5126 || uv.type !== "VEC2" || uv.componentType !== 5126 || norm.count !== pos.count || uv.count !== pos.count || !idx || idx.type !== "SCALAR" || ![5121, 5123, 5125].includes(idx.componentType)
      || idx.count % 3 || !json.materials?.[p.material]?.pbrMetallicRoughness) throw new Error("GLB requires textured triangle geometry");
    const view = views[idx.bufferView], step = ({ 5121: 1, 5123: 2, 5125: 4 } as Record<number, number>)[idx.componentType]!;
    for (let i = 0; i < idx.count; i++) {
      const at = binaryOffset + (view.byteOffset ?? 0) + (idx.byteOffset ?? 0) + i * (view.byteStride ?? step);
      const index = step === 1 ? data.readUInt8(at) : step === 2 ? data.readUInt16LE(at) : data.readUInt32LE(at);
      if (index >= pos.count) throw new Error("GLB index out of bounds");
    }
    for (const a of [pos, norm, uv]) {
      const v = views[a.bufferView], count = a.type === "VEC2" ? 2 : 3;
      for (let i = 0; i < a.count; i++) for (let c = 0; c < count; c++) {
        const at = binaryOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * (v.byteStride ?? count * 4) + c * 4;
        if (!Number.isFinite(data.readFloatLE(at))) throw new Error("non-finite GLB geometry");
      }
    }
    vertices += pos.count; triangles += idx.count / 3;
  }
  if (!json.images?.length) throw new Error("GLB requires embedded textures");
  for (const image of json.images ?? []) if (image.uri || !views[image.bufferView] || !["image/webp", "image/png", "image/jpeg"].includes(image.mimeType)) throw new Error("GLB images must be embedded");
  return meshGeometrySchema.parse({ vertices, triangles, textures: json.images?.length ?? 0, extensions: json.extensionsUsed ?? [] });
}
