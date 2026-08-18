const SESSION_KEY = "pr-proof.control-plane.session";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function defaultStorage() {
  try { return window.localStorage; } catch { return memoryStorage(); }
}

function sessionFor(name, email) {
  return {
    userId: "dev-user-001",
    name: name.trim() || "Developer",
    email: email.trim().toLowerCase(),
    organizationId: "org-atlas",
    role: "owner",
    planId: "developer",
    developmentOnly: true,
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
  };
}

function validSession(value) {
  return Boolean(value && typeof value === "object" && typeof value.userId === "string" && typeof value.name === "string" && typeof value.email === "string" && typeof value.organizationId === "string" && ["owner", "admin", "maintainer", "reviewer", "viewer", "billing_administrator"].includes(value.role) && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > Date.now());
}

export function createDevelopmentAuth(storage = defaultStorage()) {
  return {
    async getSession() {
      let raw;
      try { raw = storage.getItem(SESSION_KEY); } catch { return null; }
      if (!raw) return null;
      try {
        const session = JSON.parse(raw);
        if (!validSession(session)) {
          try { storage.removeItem(SESSION_KEY); } catch { /* best effort cleanup */ }
          return null;
        }
        return session;
      } catch {
        try { storage.removeItem(SESSION_KEY); } catch { /* best effort cleanup */ }
        return null;
      }
    },
    async signIn({ email, password }) {
      if (typeof email !== "string" || !email.includes("@")) return { error: "Enter a valid email address." };
      if (typeof password !== "string" || password.length < 8 || password === "wrong-password") return { error: "The development sign-in was rejected. Use any 8+ character password other than the test failure value." };
      const session = sessionFor("Alex Morgan", email);
      try { storage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { return { error: "The local session store is unavailable." }; }
      return { session };
    },
    async signUp({ name, email, password }) {
      if (typeof name !== "string" || !name.trim()) return { error: "Enter your name." };
      if (typeof email !== "string" || !email.includes("@")) return { error: "Enter a valid email address." };
      if (typeof password !== "string" || password.length < 8) return { error: "Use at least 8 characters for the development password." };
      const session = sessionFor(name, email);
      try { storage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { return { error: "The local session store is unavailable." }; }
      return { session };
    },
    async requestPasswordReset(email) {
      if (typeof email !== "string" || !email.includes("@")) return { accepted: false, message: "Enter a valid email address." };
      return { accepted: true, message: "In production, the configured provider would send a reset link. No email was sent by this development adapter." };
    },
    async signOut() {
      try { storage.removeItem(SESSION_KEY); } catch { /* best effort sign-out */ }
    },
  };
}

export function safeReturnTo(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value) || !value.startsWith("/") || value.startsWith("//") || value.includes("://")) return "/app/overview";
  return value;
}
