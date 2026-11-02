import { and, asc, eq, sql } from "drizzle-orm";

import { isRole, type Role } from "../../../../domain/roles";
import type { EmployeeRecord, EmployeeStore } from "../../../../usecases/masters/employees.port";
import { auditInsert, type Db } from "../../client";
import { employees } from "../../schema";

type Row = typeof employees.$inferSelect;

function toRecord(r: Row): EmployeeRecord {
  const roles: Role[] = r.roles.filter(isRole);
  return {
    id: r.id,
    authUserId: r.authUserId,
    email: r.email,
    name: r.name,
    roles,
    active: r.active,
    version: r.version,
  };
}

export function employeeStore(db: Db): EmployeeStore {
  return {
    get(id) {
      const r = db.select().from(employees).where(eq(employees.id, id)).get();
      return r ? toRecord(r) : undefined;
    },
    findByEmail(email) {
      const r = db.select().from(employees).where(eq(employees.email, email.toLowerCase())).get();
      return r ? toRecord(r) : undefined;
    },
    findByAuthUserId(authUserId) {
      const r = db.select().from(employees).where(eq(employees.authUserId, authUserId)).get();
      return r ? toRecord(r) : undefined;
    },
    list() {
      return db.select().from(employees).orderBy(asc(employees.name)).all().map(toRecord);
    },
    insert(record, meta) {
      db.insert(employees)
        .values({
          ...record,
          email: record.email.toLowerCase(),
          roles: [...record.roles],
          ...auditInsert(meta),
        })
        .run();
    },
    update(id, expectedVersion, patch, meta) {
      const { roles, ...rest } = patch;
      const rows = db
        .update(employees)
        .set({
          ...rest,
          ...(roles ? { roles: [...roles] } : {}),
          version: sql`${employees.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(employees.id, id), eq(employees.version, expectedVersion)))
        .returning({ id: employees.id })
        .all();
      return rows.length === 1;
    },
  };
}
