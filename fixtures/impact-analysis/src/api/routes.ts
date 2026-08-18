import { refreshSession } from "../auth/session";

export function registerRoutes(app: { get(path: string, handler: () => string): void }): void {
  app.get("/session", () => refreshSession("user-1"));
}
