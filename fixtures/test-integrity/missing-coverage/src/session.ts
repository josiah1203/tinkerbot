export function refreshSession(token: string): string {
  if (!token) throw new Error("missing token");
  return token;
}
