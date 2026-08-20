import { refreshSession } from "./session";

test("refreshes a session", () => {
  expect(refreshSession("user-1")).toBeTruthy();
});

test.skip("handles revoked sessions", () => {
  expect(refreshSession("revoked")).toThrow();
});
