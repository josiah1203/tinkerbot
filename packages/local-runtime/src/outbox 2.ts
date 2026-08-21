import type { FactoryStore } from "../../factory/src/store";
import { assertNoSecretInPayload } from "./credentials";

export interface SyncPostResult {
  ok: boolean;
  status?: number;
  body?: Record<string, unknown>;
}

export async function replayOutbox(
  store: Pick<FactoryStore, "listOutbox" | "markOutboxSynced">,
  post: (kind: string, payload: Record<string, unknown>) => Promise<SyncPostResult>,
  now = new Date().toISOString(),
): Promise<{ synced: number; failed: number }> {
  const pending = await store.listOutbox(50);
  let synced = 0;
  let failed = 0;
  for (const event of pending) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
    } catch {
      failed += 1;
      continue;
    }
    try {
      assertNoSecretInPayload(payload);
    } catch {
      failed += 1;
      continue;
    }
    const result = await post(event.kind, { origin: "local", kind: event.kind, ...payload });
    if (result.ok) {
      await store.markOutboxSynced(event.eventId, now);
      synced += 1;
    } else failed += 1;
  }
  return { synced, failed };
}
