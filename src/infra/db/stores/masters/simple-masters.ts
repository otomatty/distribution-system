import { and, asc, eq, sql } from "drizzle-orm";

import type {
  SimpleMasterRecord,
  SimpleMasterStore,
} from "../../../../usecases/masters/simple-masters.port";
import { auditInsert, type Db } from "../../client";
import { genres, stores } from "../../schema";

type Table = typeof genres | typeof stores;

function toRecord(r: Table["$inferSelect"]): SimpleMasterRecord {
  return {
    id: r.id,
    name: r.name,
    displayOrder: r.displayOrder,
    archived: r.archived,
    version: r.version,
    updatedAt: r.updatedAt,
  };
}

/** 名前と表示順だけのマスタ（ジャンル：genres、払い出し先店舗：stores）の実装 */
function simpleMasterStore(db: Db, table: Table): SimpleMasterStore {
  return {
    get(id) {
      const r = db.select().from(table).where(eq(table.id, id)).get();
      return r ? toRecord(r) : undefined;
    },
    list(includeArchived) {
      return db
        .select()
        .from(table)
        .where(includeArchived ? undefined : eq(table.archived, false))
        .orderBy(asc(table.archived), asc(table.displayOrder), asc(table.name))
        .all()
        .map(toRecord);
    },
    options() {
      return db
        .select({ id: table.id, name: table.name })
        .from(table)
        .where(eq(table.archived, false))
        .orderBy(asc(table.displayOrder), asc(table.name))
        .all();
    },
    findByName(name) {
      const r = db.select().from(table).where(eq(table.name, name)).get();
      return r ? toRecord(r) : undefined;
    },
    insert(id, fields, meta) {
      db.insert(table)
        .values({ id, ...fields, archived: false, ...auditInsert(meta) })
        .run();
    },
    update(id, expectedVersion, patch, meta) {
      const rows = db
        .update(table)
        .set({
          ...patch,
          version: sql`${table.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(table.id, id), eq(table.version, expectedVersion)))
        .returning({ id: table.id })
        .all();
      return rows.length === 1;
    },
  };
}

export const genreStore = (db: Db) => simpleMasterStore(db, genres);
export const retailStoreStore = (db: Db) => simpleMasterStore(db, stores);
