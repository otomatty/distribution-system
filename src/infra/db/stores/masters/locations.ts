import { and, asc, eq, sql } from "drizzle-orm";

import type { LocationRecord, LocationStore } from "../../../../usecases/masters/locations.port";
import { auditInsert, type Db } from "../../client";
import { locations } from "../../schema";

function toRecord(r: typeof locations.$inferSelect): LocationRecord {
  return {
    id: r.id,
    name: r.name,
    contactName: r.contactName,
    postalCode: r.postalCode,
    address: r.address,
    phone: r.phone,
    mobile: r.mobile,
    fax: r.fax,
    email: r.email,
    lineId: r.lineId,
    mainContact: r.mainContact,
    memo: r.memo,
    displayOrder: r.displayOrder,
    archived: r.archived,
    version: r.version,
    updatedAt: r.updatedAt,
  };
}

export function locationStore(db: Db): LocationStore {
  return {
    get(id) {
      const r = db.select().from(locations).where(eq(locations.id, id)).get();
      return r ? toRecord(r) : undefined;
    },
    list(includeArchived) {
      return db
        .select()
        .from(locations)
        .where(includeArchived ? undefined : eq(locations.archived, false))
        .orderBy(asc(locations.archived), asc(locations.displayOrder), asc(locations.name))
        .all()
        .map(toRecord);
    },
    options() {
      return db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(eq(locations.archived, false))
        .orderBy(asc(locations.displayOrder), asc(locations.name))
        .all();
    },
    findByName(name) {
      const r = db.select().from(locations).where(eq(locations.name, name)).get();
      return r ? toRecord(r) : undefined;
    },
    insert(id, fields, meta) {
      db.insert(locations)
        .values({ id, ...fields, archived: false, ...auditInsert(meta) })
        .run();
    },
    update(id, expectedVersion, patch, meta) {
      const rows = db
        .update(locations)
        .set({
          ...patch,
          version: sql`${locations.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(locations.id, id), eq(locations.version, expectedVersion)))
        .returning({ id: locations.id })
        .all();
      return rows.length === 1;
    },
  };
}
