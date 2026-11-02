import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import type * as schema from "./schema";

export type Schema = typeof schema;

/** 業務 DB（Durable Objects の SQLite）。トランザクション内の tx もこの型で扱う。 */
export type Db = BaseSQLiteDatabase<
  "sync",
  SqlStorageCursor<Record<string, SqlStorageValue>>,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

export function auditInsert(meta: { at: string; by: string }) {
  return {
    createdAt: meta.at,
    createdBy: meta.by,
    updatedAt: meta.at,
    updatedBy: meta.by,
    version: 1,
  };
}

/** LIKE 検索用に % と _ をエスケープする */
export function likePattern(q: string): string {
  return `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}
