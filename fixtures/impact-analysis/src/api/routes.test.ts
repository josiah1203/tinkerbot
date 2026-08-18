import { refreshSession } from "../auth/session";

test("session route uses refresh behavior", () => {
  expect(refreshSession("user-1")).toBe("user-1");
});
