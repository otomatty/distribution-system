import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type {
  PurchaseReturnRecord,
  PurchaseReturnStore,
} from "../../../../usecases/purchasing/purchase-returns.port";
import { auditInsert, type Db } from "../../client";
import {
  employees,
  items,
  locations,
  purchaseReturnLines,
  purchaseReturns,
  supplierInvoices,
} from "../../schema";
import { inList, insertBatches } from "../../sql-helpers";

/** 仕入返品の明細の列数（INSERT を分ける単位の計算に使う） */
const LINE_COLUMNS = 8;

const cancelledBy = alias(employees, "cancelled_by_employee");

export function purchaseReturnStore(db: Db): PurchaseReturnStore {
  /** 条件に合う仕入返品と明細（返品日・記録の順） */
  function load(where: SQL): PurchaseReturnRecord[] {
    const headers = db
      .select({
        id: purchaseReturns.id,
        number: purchaseReturns.number,
        supplierId: purchaseReturns.supplierId,
        purchaseOrderId: sql<string>`coalesce(${purchaseReturns.purchaseOrderId}, '')`,
        returnedOn: purchaseReturns.returnedOn,
        locationId: purchaseReturns.locationId,
        memo: purchaseReturns.memo,
        supplierInvoiceId: purchaseReturns.supplierInvoiceId,
        supplierInvoiceStatus: supplierInvoices.status,
        cancelled: purchaseReturns.cancelled,
        cancelReason: purchaseReturns.cancelReason,
        cancelledAt: purchaseReturns.cancelledAt,
        cancelledByName: cancelledBy.name,
        version: purchaseReturns.version,
        createdAt: purchaseReturns.createdAt,
        createdByName: employees.name,
        locationName: sql<string>`coalesce(${locations.name}, '')`,
      })
      .from(purchaseReturns)
      .leftJoin(supplierInvoices, eq(supplierInvoices.id, purchaseReturns.supplierInvoiceId))
      .leftJoin(employees, eq(employees.id, purchaseReturns.createdBy))
      .leftJoin(cancelledBy, eq(cancelledBy.id, purchaseReturns.cancelledBy))
      .leftJoin(locations, eq(locations.id, purchaseReturns.locationId))
      .where(where)
      .orderBy(asc(purchaseReturns.returnedOn), asc(purchaseReturns.id))
      .all();
    if (headers.length === 0) return [];
    const lines = db
      .select({
        purchaseReturnId: purchaseReturnLines.purchaseReturnId,
        id: purchaseReturnLines.id,
        purchaseOrderLineId: sql<string>`coalesce(${purchaseReturnLines.purchaseOrderLineId}, '')`,
        itemId: purchaseReturnLines.itemId,
        quantity: purchaseReturnLines.quantity,
        unitPriceCenti: purchaseReturnLines.unitPriceCenti,
        amount: purchaseReturnLines.amount,
        taxCategory: purchaseReturnLines.taxCategory,
        itemCode: sql<string>`coalesce(${items.code}, '')`,
        itemName: sql<string>`coalesce(${items.name}, '（不明な商品）')`,
        salesUnitName: sql<string>`coalesce(${items.salesUnitName}, '')`,
      })
      .from(purchaseReturnLines)
      .leftJoin(items, eq(items.id, purchaseReturnLines.itemId))
      .where(
        inList(
          purchaseReturnLines.purchaseReturnId,
          headers.map((h) => h.id),
        ),
      )
      .orderBy(asc(purchaseReturnLines.id))
      .all();
    return headers.map((h) =>
      Object.assign(h, {
        lines: lines
          .filter((l) => l.purchaseReturnId === h.id)
          .map(({ purchaseReturnId: _id, ...l }) => l),
      }),
    );
  }

  return {
    insert(id, fields, lines, meta) {
      db.insert(purchaseReturns)
        .values({ id, ...fields, cancelled: false, ...auditInsert(meta) })
        .run();
      const values = lines.map((l) => ({ ...l, purchaseReturnId: id }));
      for (const batch of insertBatches(values, LINE_COLUMNS)) {
        db.insert(purchaseReturnLines).values(batch).run();
      }
    },
    get(id) {
      return load(eq(purchaseReturns.id, id))[0];
    },
    listByOrder(orderId): PurchaseReturnRecord[] {
      return load(eq(purchaseReturns.purchaseOrderId, orderId));
    },
    markCancelled(id, expectedVersion, reason, meta) {
      const rows = db
        .update(purchaseReturns)
        .set({
          cancelled: true,
          cancelReason: reason,
          cancelledAt: meta.at,
          cancelledBy: meta.by,
          version: sql`${purchaseReturns.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(
          and(
            eq(purchaseReturns.id, id),
            eq(purchaseReturns.version, expectedVersion),
            eq(purchaseReturns.cancelled, false),
          ),
        )
        .returning({ id: purchaseReturns.id })
        .all();
      return rows.length === 1;
    },
    returnedByLine(orderId) {
      return db
        .select({
          lineId: sql<string>`coalesce(${purchaseReturnLines.purchaseOrderLineId}, '')`,
          units: sql<number>`coalesce(sum(${purchaseReturnLines.quantity}), 0)`,
        })
        .from(purchaseReturnLines)
        .innerJoin(purchaseReturns, eq(purchaseReturns.id, purchaseReturnLines.purchaseReturnId))
        .where(
          and(eq(purchaseReturns.purchaseOrderId, orderId), eq(purchaseReturns.cancelled, false)),
        )
        .groupBy(purchaseReturnLines.purchaseOrderLineId)
        .all();
    },
  };
}
