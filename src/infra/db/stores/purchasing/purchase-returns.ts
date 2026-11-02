import { and, asc, eq, sql } from "drizzle-orm";

import type {
  PurchaseReturnRecord,
  PurchaseReturnStore,
} from "../../../../usecases/purchasing/purchase-returns.port";
import { auditInsert, type Db } from "../../client";
import { employees, items, locations, purchaseReturnLines, purchaseReturns } from "../../schema";
import { inList, insertBatches } from "../../sql-helpers";

/** 仕入返品の明細の列数（INSERT を分ける単位の計算に使う） */
const LINE_COLUMNS = 8;

export function purchaseReturnStore(db: Db): PurchaseReturnStore {
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
    listByOrder(orderId): PurchaseReturnRecord[] {
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
          cancelled: purchaseReturns.cancelled,
          createdAt: purchaseReturns.createdAt,
          createdByName: employees.name,
          locationName: sql<string>`coalesce(${locations.name}, '')`,
        })
        .from(purchaseReturns)
        .leftJoin(employees, eq(employees.id, purchaseReturns.createdBy))
        .leftJoin(locations, eq(locations.id, purchaseReturns.locationId))
        .where(eq(purchaseReturns.purchaseOrderId, orderId))
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
