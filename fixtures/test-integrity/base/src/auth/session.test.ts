import { refreshSession } from "./session";

test("refreshes a session", () => {
  expect(refreshSession("user-1")).toEqual({ ok: true, userId: "user-1" });
});
