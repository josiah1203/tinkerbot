export function refreshSession(token: string): { ok: boolean; userId: string } {
  if (!token) throw new Error("missing token");
  return { ok: true, userId: token };
}
