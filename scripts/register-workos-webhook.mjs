import { chmod, writeFile } from "node:fs/promises";

const apiKey = process.env.WORKOS_API_KEY?.trim();
const endpointUrl = process.env.WORKOS_WEBHOOK_URL?.trim();
const secretFile = process.env.WORKOS_WEBHOOK_SECRET_FILE?.trim();
const events = [
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organization_membership.created",
  "organization_membership.updated",
  "organization_membership.deleted",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "invitation.resent",
];

if (!apiKey) throw new Error("WORKOS_API_KEY is required.");
if (!endpointUrl || !endpointUrl.startsWith("https://")) throw new Error("WORKOS_WEBHOOK_URL must be an HTTPS URL.");

async function request(path, init = {}) {
  const response = await fetch(`https://api.workos.com${path}`, {
    ...init,
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* response details are intentionally not echoed */ }
  if (!response.ok) throw new Error(`WorkOS webhook API returned HTTP ${response.status}.`);
  return body;
}

function publicEndpoint(endpoint, action) {
  return {
    action,
    id: endpoint.id,
    endpointUrl: endpoint.endpoint_url,
    status: endpoint.status,
    events: endpoint.events,
    secretReturned: typeof endpoint.secret === "string",
  };
}

async function persistSecret(endpoint) {
  if (!secretFile || typeof endpoint.secret !== "string") return false;
  await writeFile(secretFile, `${endpoint.secret}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(secretFile, 0o600);
  return true;
}

const listed = await request("/webhook_endpoints?limit=100&order=desc");
const current = Array.isArray(listed.data) ? listed.data.find((item) => item?.endpoint_url === endpointUrl) : undefined;
let endpoint;
let action;
if (!current) {
  endpoint = await request("/webhook_endpoints", { method: "POST", body: JSON.stringify({ endpoint_url: endpointUrl, events }) });
  action = "created";
} else {
  const currentEvents = Array.isArray(current.events) ? current.events : [];
  const complete = events.every((event) => currentEvents.includes(event));
  if (complete && current.status === "enabled") {
    endpoint = current;
    action = "reused";
  } else {
    endpoint = await request(`/webhook_endpoints/${encodeURIComponent(current.id)}`, { method: "PATCH", body: JSON.stringify({ endpoint_url: endpointUrl, status: "enabled", events }) });
    action = "updated";
  }
}

const persistedSecret = await persistSecret(endpoint);
console.log(JSON.stringify({ ...publicEndpoint(endpoint, action), secretPersisted: persistedSecret, secretFile: persistedSecret ? secretFile : null }));
