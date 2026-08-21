import { createRequire } from "node:module";

export interface SqliteStatement {
  run(...params: unknown[]): { changes?: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeSqliteModule {
    DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes?: number };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  };
}

export function openSqliteDatabase(filePath: string): SqliteDatabase {
  let sqlite: NodeSqliteModule;
  try {
    sqlite = createRequire(__filename)("node:sqlite") as NodeSqliteModule;
  } catch {
    throw new Error("Local factory state requires Node.js node:sqlite (Node 22+). The Cloudflare Worker must not import this package.");
  }
  const database = new sqlite.DatabaseSync(filePath);
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        run: (...params) => statement.run(...params) as { changes?: number },
        get: (...params) => statement.get(...params) as Record<string, unknown> | undefined,
        all: (...params) => (statement.all(...params) ?? []) as Array<Record<string, unknown>>,
      };
    },
    close: () => database.close(),
  };
}

export const SQLITE_MAGIC = "SQLite format 3";
