import { and, count, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import type {
  AuditLogFilter,
  AuditLogRecord,
  AuditLogStore,
} from "../../../../usecases/platform/audit-logs.port";
import type { Page } from "../../../../usecases/schemas";
import type { Db } from "../../client";
import {
  auditLogs,
  disposals,
  documents,
  employees,
  invoices,
  items,
  purchaseOrders,
  purchaseReturns,
  receipts,
  salesOrders,
  salesReturns,
  shipments,
  stockOperations,
  supplierInvoices,
} from "../../schema";
import { inList } from "../../sql-helpers";

function conditions(filter: AuditLogFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.from) conds.push(gte(auditLogs.occurredAt, filter.from));
  if (filter.until) conds.push(lt(auditLogs.occurredAt, filter.until));
  if (filter.employeeId) conds.push(eq(auditLogs.employeeId, filter.employeeId));
  if (filter.entityType) conds.push(eq(auditLogs.entityType, filter.entityType));
  if (filter.entityIds) conds.push(inList(auditLogs.entityId, filter.entityIds));
  if (filter.action) conds.push(eq(auditLogs.action, filter.action));
  return conds.length > 0 ? and(...conds) : undefined;
}

/** 番号・コードの列と、その表の ID の列（完全一致で引く。件数の多い表から順に） */
const NUMBER_COLUMNS: readonly (readonly [SQLiteColumn, SQLiteColumn])[] = [
  [salesOrders.number, salesOrders.id],
  [shipments.deliveryNoteNumber, shipments.id],
  [purchaseOrders.number, purchaseOrders.id],
  [invoices.number, invoices.id],
  [documents.number, documents.id],
  [receipts.number, receipts.id],
  [purchaseReturns.number, purchaseReturns.id],
  [salesReturns.number, salesReturns.id],
  [disposals.number, disposals.id],
  [stockOperations.number, stockOperations.id],
  [supplierInvoices.invoiceNumber, supplierInvoices.id],
  [items.code, items.id],
];

export function auditLogStore(db: Db): AuditLogStore {
  return {
    search(filter, page, pageSize): Page<AuditLogRecord> {
      const where = conditions(filter);
      const total = db.select({ n: count() }).from(auditLogs).where(where).get()?.n ?? 0;
      const rows = db
        .select({
          id: auditLogs.id,
          occurredAt: auditLogs.occurredAt,
          employeeId: auditLogs.employeeId,
          employeeName: employees.name,
          command: auditLogs.command,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          beforeJson: auditLogs.beforeJson,
          afterJson: auditLogs.afterJson,
        })
        .from(auditLogs)
        .leftJoin(employees, eq(employees.id, auditLogs.employeeId))
        .where(where)
        // 同じ操作（同じ日時）の中では記録した順（ULID）の逆
        .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows, total, page, pageSize };
    },
    idsForNumber(number) {
      const ids = new Set<string>();
      for (const [numberColumn, idColumn] of NUMBER_COLUMNS) {
        const found = db
          .select({ id: idColumn })
          .from(idColumn.table)
          .where(eq(numberColumn, number))
          .limit(20)
          .all();
        for (const r of found) if (typeof r.id === "string") ids.add(r.id);
      }
      return [...ids];
    },
  };
}
