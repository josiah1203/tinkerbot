import { changedService } from "./service";
export function register(app: { get(path: string, handler: () => string): void }): void { app.get("/session", () => changedService("u")); }
