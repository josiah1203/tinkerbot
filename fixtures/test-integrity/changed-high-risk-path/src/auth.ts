export function authorize(token: string): boolean {
  if (!token) throw new Error("unauthorized");
  return token.startsWith("admin:");
}
