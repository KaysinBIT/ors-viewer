const TRIANGLE_VERTICES = 3;
const INDEX_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const FACE_BYTES = 1 + TRIANGLE_VERTICES * INDEX_BYTES;

// Display-only clipping remains excluded. Preserve the original little-endian layout.
export function createPreviewPLY(positions, indices) {
  const header = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\ncomment ORS Viewer display mesh; clipping not applied\nelement vertex ${positions.length/TRIANGLE_VERTICES}\nproperty float x\nproperty float y\nproperty float z\nelement face ${indices.length/TRIANGLE_VERTICES}\nproperty list uchar uint vertex_indices\nend_header\n`);
  const faceCount = indices.length / TRIANGLE_VERTICES;
  const faces = new Uint8Array(faceCount * FACE_BYTES);
  const view = new DataView(faces.buffer);
  for (let face = 0; face < faceCount; face++) {
    const offset = face * FACE_BYTES;
    view.setUint8(offset, TRIANGLE_VERTICES);
    for (let corner = 0; corner < TRIANGLE_VERTICES; corner++) {
      view.setUint32(offset + 1 + corner * INDEX_BYTES, indices[face * TRIANGLE_VERTICES + corner], true);
    }
  }
  return new Blob([header, positions, faces], {type:'application/octet-stream'});
}
