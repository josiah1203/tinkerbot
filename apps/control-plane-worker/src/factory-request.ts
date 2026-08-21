export type BoundedJsonResult = { value: Record<string, unknown> } | { tooLarge: true };

/** Read a JSON object without allowing an unbounded request body into a route. */
export async function boundedJsonObject(request: Request, maxBytes = 1_500_000): Promise<BoundedJsonResult> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return { tooLarge: true };
  if (!request.body) return { value: {} };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* bounded request is already rejected */ }
        return { tooLarge: true };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { value: parsed as Record<string, unknown> } : { value: {} };
  } catch {
    return { value: {} };
  }
}
