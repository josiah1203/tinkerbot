import {
  clearCookie,
  cookieValue,
  expired,
  invitationEmail,
  invitationRole,
  publicSession,
  roleHasCapability,
  sessionCookie,
} from "../apps/control-plane-worker/src/tenant-auth";

test("tenant auth boundary keeps cookies scoped and decodes only the selected value", () => {
  const request = new Request("https://control.example/auth/session", {
    headers: { cookie: "other=ignored; tinkerbot_session=session%2F1; tinkerbot_pkce=verifier" },
  });
  expect(cookieValue(request, "tinkerbot_session")).toBe("session/1");
  expect(cookieValue(request, "missing")).toBeUndefined();
  expect(sessionCookie("session/1")).toContain("tinkerbot_session=session%2F1");
  expect(clearCookie("tinkerbot_session")).toContain("Max-Age=0");
});

test("tenant auth boundary preserves session visibility without exposing credentials", () => {
  const session = {
    user: { id: "user_1", email: "user@example.com", firstName: "User" },
    organizationId: "org_1",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
    authenticationMethod: "workos_sso",
  } as const;
  expect(expired(session)).toBe(false);
  expect(expired({ ...session, expiresAt: "2000-01-01T00:00:00.000Z" })).toBe(true);
  expect(publicSession(session)).toEqual({ user: session.user, organizationId: "org_1", expiresAt: session.expiresAt, authenticationMethod: "workos_sso" });
  expect(JSON.stringify(publicSession(session))).not.toContain("access-token");
  expect(JSON.stringify(publicSession(session))).not.toContain("refresh-token");
});

test("tenant auth boundary validates invite input and preserves least privilege", () => {
  expect(invitationEmail(" Person@Example.COM ")).toBe("person@example.com");
  expect(invitationEmail("not-an-email")).toBeNull();
  expect(invitationRole("maintainer")).toBe("maintainer");
  expect(invitationRole("owner")).toBeNull();
  expect(roleHasCapability("maintainer", "factory:write")).toBe(true);
  expect(roleHasCapability("maintainer", "assurance:delete")).toBe(false);
});
