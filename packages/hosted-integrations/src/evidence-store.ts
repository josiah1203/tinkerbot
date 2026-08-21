import type { EvidenceStore } from "./index";

export interface R2ObjectLike {
  text(): Promise<string>;
}

export interface R2BucketLike {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}

export class R2JsonEvidenceStore implements EvidenceStore {
  constructor(private readonly bucket: R2BucketLike, private readonly prefix = "evidence/") {}

  async put(key: string, value: unknown): Promise<void> {
    await this.bucket.put(`${this.prefix}${key}`, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
  }

  async get<T>(key: string): Promise<T | null> {
    const object = await this.bucket.get(`${this.prefix}${key}`);
    if (!object) return null;
    try { return JSON.parse(await object.text()) as T; } catch { return null; }
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(`${this.prefix}${key}`);
  }
}

/** Optional customer S3/GCS-compatible HTTP replica. Failures never change a tb check verdict. */
export class HttpEvidenceReplica implements EvidenceStore {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async put(key: string, value: unknown): Promise<void> {
    const response = await this.fetchImpl(`${this.endpoint.replace(/\/$/, "")}/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error(`Evidence export HTTP ${response.status}`);
  }

  async get<T>(): Promise<T | null> {
    return null;
  }

  async delete(): Promise<void> {
    return;
  }
}

export class FanoutEvidenceStore implements EvidenceStore {
  constructor(private readonly primary: EvidenceStore, private readonly replica?: EvidenceStore) {}

  async put(key: string, value: unknown): Promise<void> {
    await this.primary.put(key, value);
    if (!this.replica) return;
    try { await this.replica.put(key, value); } catch { /* replica fan-out cannot set or rewrite a verification verdict */ }
  }

  async get<T>(key: string): Promise<T | null> {
    return this.primary.get<T>(key);
  }

  async delete(key: string): Promise<void> {
    await this.primary.delete(key);
  }
}

export function evidenceStoreFromEnv(input: { bucket?: R2BucketLike; exportEndpoint?: string; exportToken?: string; fetchImpl?: typeof fetch }): EvidenceStore | undefined {
  if (!input.bucket) return undefined;
  const primary = new R2JsonEvidenceStore(input.bucket);
  const replica = input.exportEndpoint ? new HttpEvidenceReplica(input.exportEndpoint, input.exportToken, input.fetchImpl) : undefined;
  return new FanoutEvidenceStore(primary, replica);
}
