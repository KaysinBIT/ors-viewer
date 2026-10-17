export function requestErrorMessage(error){
  const message=error?.message||String(error);
  return /failed to fetch|fetch failed|networkerror|load failed/i.test(message)
    ? '无法连接本地服务。请检查软件启动窗口是否已退出；重新启动后，请从启动窗口打开新的网页地址。'
    : message;
}

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
