export async function requestJson(path, options) {
  const response = await fetch(path, options);
  if (response.ok) return response.json();
  let error;
  try { error = await response.json(); } catch { /* Preserve the HTTP status fallback. */ }
  throw new Error(error?.error || `请求失败 (${response.status})`);
}

// Preview errors intentionally use the binary endpoint's existing JSON contract.
export async function requestPreview(path, signal, parsePacket) {
  const response = await fetch(path, {signal});
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }
  return parsePacket(await response.arrayBuffer());
}
