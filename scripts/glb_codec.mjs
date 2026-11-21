/**
 * Decode and encode Draco GLBs for scripts/split_meshes.py.
 * Usage:
 *   node scripts/glb_codec.mjs decode <in.glb> <out.bin>
 *   node scripts/glb_codec.mjs encode <in.bin> <out.glb> [meshName]
 *
 * The .bin layout is: uint32 vertex count, uint32 face count,
 * float32 xyz, uint32 triangle indices.
 */
import fs from 'node:fs';
import path from 'node:path';
import draco3d from 'draco3d';

const [mode, input, output, meshName] = process.argv.slice(2);

function readBin(path) {
  const buf = fs.readFileSync(path);
  const vertexCount = buf.readUInt32LE(0);
  const faceCount = buf.readUInt32LE(4);
  const positions = new Float32Array(buf.buffer, buf.byteOffset + 8, vertexCount * 3);
  const indices = new Uint32Array(buf.buffer, buf.byteOffset + 8 + vertexCount * 12, faceCount * 3);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function writeBin(path, positions, indices) {
  const vertexCount = positions.length / 3;
  const faceCount = indices.length / 3;
  const out = Buffer.alloc(8 + positions.byteLength + indices.byteLength);
  out.writeUInt32LE(vertexCount, 0);
  out.writeUInt32LE(faceCount, 4);
  Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength).copy(out, 8);
  Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength).copy(out, 8 + positions.byteLength);
  fs.writeFileSync(path, out);
}

function decodeGlb(path) {
  return draco3d.createDecoderModule().then((decoderModule) => {
    const buf = fs.readFileSync(path);
    const jsonLength = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
    const binLength = buf.readUInt32LE(20 + jsonLength);
    const bin = buf.subarray(28 + jsonLength, 28 + jsonLength + binLength);
    const prim = json.meshes[0].primitives[0];
    const draco = prim.extensions.KHR_draco_mesh_compression;
    const view = json.bufferViews[draco.bufferView];
    const start = view.byteOffset || 0;
    const data = bin.subarray(start, start + view.byteLength);
    const decoder = new decoderModule.Decoder();
    const dbuf = new decoderModule.DecoderBuffer();
    dbuf.Init(new Int8Array(data.buffer, data.byteOffset, data.byteLength), data.byteLength);
    const geometry = new decoderModule.Mesh();
    const status = decoder.DecodeBufferToMesh(dbuf, geometry);
    if (!status.ok()) throw new Error(`Draco decode failed for ${path}`);
    const posAttr = decoder.GetAttributeByUniqueId(geometry, draco.attributes.POSITION);
    const vertexCount = geometry.num_points();
    const faceCount = geometry.num_faces();
    const posPtr = decoderModule._malloc(vertexCount * 12);
    decoder.GetAttributeDataArrayForAllPoints(geometry, posAttr, decoderModule.DT_FLOAT32, vertexCount * 12, posPtr);
    const positions = new Float32Array(decoderModule.HEAPF32.buffer, posPtr, vertexCount * 3).slice();
    const indexPtr = decoderModule._malloc(faceCount * 12);
    decoder.GetTrianglesUInt32Array(geometry, faceCount * 12, indexPtr);
    const indices = new Uint32Array(decoderModule.HEAPU32.buffer, indexPtr, faceCount * 3).slice();
    decoderModule._free(posPtr);
    decoderModule._free(indexPtr);
    decoderModule.destroy(geometry);
    decoderModule.destroy(dbuf);
    decoderModule.destroy(decoder);
    return { positions, indices };
  });
}

function normalsFrom(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let face = 0; face < indices.length; face += 3) {
    const ia = indices[face] * 3;
    const ib = indices[face + 1] * 3;
    const ic = indices[face + 2] * 3;
    const ax = positions[ib] - positions[ia];
    const ay = positions[ib + 1] - positions[ia + 1];
    const az = positions[ib + 2] - positions[ia + 2];
    const bx = positions[ic] - positions[ia];
    const by = positions[ic + 1] - positions[ia + 1];
    const bz = positions[ic + 2] - positions[ia + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    normals[ia] += nx;
    normals[ia + 1] += ny;
    normals[ia + 2] += nz;
    normals[ib] += nx;
    normals[ib + 1] += ny;
    normals[ib + 2] += nz;
    normals[ic] += nx;
    normals[ic + 1] += ny;
    normals[ic + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= length;
    normals[i + 1] /= length;
    normals[i + 2] /= length;
  }
  return normals;
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min, max };
}

async function encodeGlb(binPath, glbPath, name) {
  const encoderModule = await draco3d.createEncoderModule();
  const { positions, indices } = readBin(binPath);
  const vertexCount = positions.length / 3;
  const faceCount = indices.length / 3;
  if (!vertexCount || !faceCount) throw new Error(`empty mesh ${binPath}`);
  const normalValues = normalsFrom(positions, indices);
  const builder = new encoderModule.MeshBuilder();
  const mesh = new encoderModule.Mesh();
  builder.AddFacesToMesh(mesh, faceCount, indices);
  builder.AddFloatAttributeToMesh(mesh, encoderModule.POSITION, vertexCount, 3, positions);
  builder.AddFloatAttributeToMesh(mesh, encoderModule.NORMAL, vertexCount, 3, normalValues);
  const encoder = new encoderModule.Encoder();
  encoder.SetEncodingMethod(encoderModule.MESH_EDGEBREAKER_ENCODING);
  encoder.SetAttributeQuantization(encoderModule.POSITION, 14);
  encoder.SetAttributeQuantization(encoderModule.NORMAL, 10);
  encoder.SetSpeedOptions(5, 5);
  const encoded = new encoderModule.DracoInt8Array();
  const encodedLength = encoder.EncodeMeshToDracoBuffer(mesh, encoded);
  if (!encodedLength) throw new Error(`Draco encode failed for ${binPath}`);
  const bytes = Buffer.alloc(encodedLength);
  for (let i = 0; i < encodedLength; i += 1) bytes[i] = encoded.GetValue(i);
  const { min, max } = bounds(positions);
  const json = {
    asset: { version: '2.0', generator: 'ent-3d split_meshes' },
    extensionsUsed: ['KHR_draco_mesh_compression'],
    extensionsRequired: ['KHR_draco_mesh_compression'],
    buffers: [{ byteLength: encodedLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: encodedLength }],
    accessors: [
      { componentType: 5125, count: faceCount * 3, type: 'SCALAR' },
      { componentType: 5126, count: vertexCount, type: 'VEC3', min, max },
      { componentType: 5126, count: vertexCount, type: 'VEC3' },
    ],
    meshes: [
      {
        name,
        primitives: [
          {
            attributes: { POSITION: 1, NORMAL: 2 },
            indices: 0,
            mode: 4,
            extensions: {
              KHR_draco_mesh_compression: {
                bufferView: 0,
                attributes: { POSITION: 0, NORMAL: 1 },
              },
            },
          },
        ],
      },
    ],
    nodes: [{ name, mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const jsonText = JSON.stringify(json);
  const jsonPad = (4 - ((jsonText.length + 20) % 4)) % 4;
  const jsonChunk = Buffer.concat([Buffer.from(jsonText), Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bytes.length % 4)) % 4;
  const binChunk = Buffer.concat([bytes, Buffer.alloc(binPad)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  fs.mkdirSync(path.dirname(glbPath), { recursive: true });
  fs.writeFileSync(glbPath, Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]));
  encoderModule.destroy(mesh);
  encoderModule.destroy(encoder);
  encoderModule.destroy(encoded);
}

if (mode === 'decode') {
  const mesh = await decodeGlb(input);
  writeBin(output, mesh.positions, mesh.indices);
} else if (mode === 'encode') {
  await encodeGlb(input, output, meshName || 'mesh');
} else {
  throw new Error('mode must be decode or encode');
}
