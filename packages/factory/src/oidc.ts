export interface GitHubOidcClaims {
  iss: string;
  aud: string | string[];
  sub?: string;
  repository?: string;
  project_path?: string;
  workflow?: string;
  ref?: string;
  sha?: string;
  run_id?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
}

export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const GITLAB_OIDC_ISSUERS = ["https://gitlab.com", "https://gitlab.com/oidc"];

const jwksCache = new Map<string, { fetchedAt: number; keys: JsonWebKey[] }>();
const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_MAX_IAT_AGE_SECONDS = 15 * 60;

export function resetOidcJwksCache(): void {
  jwksCache.clear();
}

export function validateOidcClaims(claims: GitHubOidcClaims, expected: { audience: string; repository: string; sha?: string; workflow?: string }): { ok: true } | { ok: false; reason: string } {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const gitlab = GITLAB_OIDC_ISSUERS.includes(claims.iss) || /^https:\/\/[^/]*gitlab[^/]*$/.test(claims.iss);
  if (claims.iss !== GITHUB_ACTIONS_OIDC_ISSUER && !gitlab) return { ok: false, reason: "invalid_issuer" };
  if (!audiences.includes(expected.audience)) return { ok: false, reason: "invalid_audience" };
  const repository = gitlab ? (claims.project_path ?? claims.repository) : claims.repository;
  if (repository !== expected.repository) return { ok: false, reason: "invalid_repository" };
  if (expected.sha && claims.sha && claims.sha !== expected.sha) return { ok: false, reason: "invalid_sha" };
  if (expected.workflow && claims.workflow && claims.workflow !== expected.workflow) return { ok: false, reason: "invalid_workflow" };
  return { ok: true };
}

export function decodeJwtPayload(token: string): GitHubOidcClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json) as GitHubOidcClaims;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function jwksUrlForIssuer(iss: string): string | undefined {
  if (iss === GITHUB_ACTIONS_OIDC_ISSUER) return GITHUB_ACTIONS_JWKS_URL;
  if (iss === "https://gitlab.com" || iss === "https://gitlab.com/oidc") return "https://gitlab.com/oauth/discovery/keys";
  if (/^https:\/\/[^/]*gitlab[^/]*$/.test(iss)) return `${iss.replace(/\/$/, "")}/oauth/discovery/keys`;
  return undefined;
}

function decodeJwtPart(part: string): unknown {
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

function validateTimeClaims(claims: GitHubOidcClaims, nowSeconds: number, maxIatAgeSeconds: number): { ok: true } | { ok: false; reason: string } {
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return { ok: false, reason: "invalid_exp" };
  if (claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: "not_yet_valid" };
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) return { ok: false, reason: "invalid_iat" };
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: "invalid_iat" };
  if (nowSeconds - claims.iat > maxIatAgeSeconds) return { ok: false, reason: "iat_too_old" };
  return { ok: true };
}

async function readJwks(url: string, fetchImpl: typeof fetch, forceRefresh: boolean): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(url);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("jwks_unavailable");
  const body = await response.json() as { keys?: JsonWebKey[] };
  const keys = Array.isArray(body.keys) ? body.keys.filter((key) => key && typeof key === "object") : [];
  jwksCache.set(url, { fetchedAt: Date.now(), keys });
  return keys;
}

async function verifyRs256(token: string, key: JsonWebKey): Promise<boolean> {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", { ...key, kty: "RSA", alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, base64UrlToBytes(signature) as BufferSource, new TextEncoder().encode(`${header}.${payload}`));
  } catch {
    return false;
  }
}

export async function verifyOidcJwt(
  token: string,
  expected: { audience: string; repository: string; sha?: string; workflow?: string },
  options: { nowSeconds?: number; fetchImpl?: typeof fetch; maxIatAgeSeconds?: number } = {},
): Promise<{ ok: true; claims: GitHubOidcClaims } | { ok: false; reason: string }> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2] || parts[2] === "sig") return { ok: false, reason: "unsigned_or_malformed" };
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: GitHubOidcClaims;
  try {
    header = decodeJwtPart(parts[0]) as { alg?: string; kid?: string; typ?: string };
    claims = decodeJwtPart(parts[1]) as GitHubOidcClaims;
  } catch {
    return { ok: false, reason: "malformed_jwt" };
  }
  if (!claims || typeof claims !== "object" || header.alg !== "RS256") return { ok: false, reason: "invalid_algorithm" };
  const timed = validateTimeClaims(claims, options.nowSeconds ?? Math.floor(Date.now() / 1000), options.maxIatAgeSeconds ?? DEFAULT_MAX_IAT_AGE_SECONDS);
  if (!timed.ok) return timed;
  const checked = validateOidcClaims(claims, expected);
  if (!checked.ok) return checked;
  const jwksUrl = jwksUrlForIssuer(claims.iss);
  if (!jwksUrl) return { ok: false, reason: "invalid_issuer" };
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    let keys = await readJwks(jwksUrl, fetchImpl, false);
    let key = header.kid ? keys.find((item) => item.kid === header.kid) : keys[0];
    if (!key && header.kid) {
      keys = await readJwks(jwksUrl, fetchImpl, true);
      key = keys.find((item) => item.kid === header.kid);
    }
    if (!key) return { ok: false, reason: "jwks_key_not_found" };
    if (!await verifyRs256(token, key)) return { ok: false, reason: "invalid_signature" };
    return { ok: true, claims };
  } catch {
    return { ok: false, reason: "jwks_unavailable" };
  }
}

export function oidcReplayKey(token: string, claims: GitHubOidcClaims): string {
  if (typeof claims.jti === "string" && claims.jti.trim()) return `jti:${claims.jti.trim()}`;
  return `tok:${token.slice(0, 80)}`;
}
