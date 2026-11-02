import { and, asc, count, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type {
  ReceiptLineRecord,
  ReceiptRecord,
  ReceiptStore,
  ScheduledLine,
} from "../../../../usecases/purchasing/receipts.port";
import { auditInsert, type Db } from "../../client";
import {
  employees,
  items,
  locations,
  partners,
  purchaseOrderLines,
  purchaseOrders,
  receiptLines,
  receipts,
  supplierInvoices,
} from "../../schema";
import { inList, insertBatches } from "../../sql-helpers";

/** 入荷の明細の列数（INSERT を分ける単位の計算に使う） */
const LINE_COLUMNS = 11;

const customers = alias(partners, "destination_customer");

export function receiptStore(db: Db): ReceiptStore {
  function linesOf(receiptIds: readonly string[]): Map<string, ReceiptLineRecord[]> {
    const out = new Map<string, ReceiptLineRecord[]>();
    if (receiptIds.length === 0) return out;
    const rows = db
      .select({
        receiptId: receiptLines.receiptId,
        id: receiptLines.id,
        purchaseOrderLineId: receiptLines.purchaseOrderLineId,
        itemId: receiptLines.itemId,
        accepted: receiptLines.accepted,
        returned: receiptLines.returned,
        closedRemaining: receiptLines.closedRemaining,
        unitPriceCenti: receiptLines.unitPriceCenti,
        unitsPerPurchaseUnit: receiptLines.unitsPerPurchaseUnit,
        taxCategory: receiptLines.taxCategory,
        amount: receiptLines.amount,
        itemCode: sql<string>`coalesce(${items.code}, '')`,
        itemName: sql<string>`coalesce(${items.name}, '（不明な商品）')`,
        purchaseUnitName: sql<string>`coalesce(${items.purchaseUnitName}, '')`,
        lineNo: purchaseOrderLines.lineNo,
      })
      .from(receiptLines)
      .leftJoin(items, eq(items.id, receiptLines.itemId))
      .leftJoin(purchaseOrderLines, eq(purchaseOrderLines.id, receiptLines.purchaseOrderLineId))
      .where(inList(receiptLines.receiptId, receiptIds))
      .orderBy(asc(purchaseOrderLines.lineNo), asc(receiptLines.id))
      .all();
    for (const { receiptId, lineNo: _lineNo, ...line } of rows) {
      out.set(receiptId, [...(out.get(receiptId) ?? []), line]);
    }
    return out;
  }

  const headerColumns = {
    id: receipts.id,
    number: receipts.number,
    purchaseOrderId: receipts.purchaseOrderId,
    receivedOn: receipts.receivedOn,
    locationId: receipts.locationId,
    memo: receipts.memo,
    supplierInvoiceId: receipts.supplierInvoiceId,
    supplierInvoiceStatus: supplierInvoices.status,
    cancelled: receipts.cancelled,
    cancelReason: receipts.cancelReason,
    version: receipts.version,
    createdAt: receipts.createdAt,
    createdByName: employees.name,
    locationName: locations.name,
  };

  function headers(where: ReturnType<typeof eq>) {
    const rows = db
      .select(headerColumns)
      .from(receipts)
      .leftJoin(supplierInvoices, eq(supplierInvoices.id, receipts.supplierInvoiceId))
      .leftJoin(employees, eq(employees.id, receipts.createdBy))
      .leftJoin(locations, eq(locations.id, receipts.locationId))
      .where(where)
      .orderBy(asc(receipts.receivedOn), asc(receipts.id))
      .all();
    const lines = linesOf(rows.map((r) => r.id));
    return rows.map((r): ReceiptRecord => Object.assign(r, { lines: lines.get(r.id) ?? [] }));
  }

  return {
    insert(id, fields, lines, meta) {
      db.insert(receipts)
        .values({ id, ...fields, cancelled: false, ...auditInsert(meta) })
        .run();
      const values = lines.map((l) => ({ ...l, receiptId: id }));
      for (const batch of insertBatches(values, LINE_COLUMNS)) {
        db.insert(receiptLines).values(batch).run();
      }
    },
    get(id) {
      return headers(eq(receipts.id, id))[0];
    },
    listByOrder(orderId) {
      return headers(eq(receipts.purchaseOrderId, orderId));
    },
    markCancelled(id, expectedVersion, reason, meta) {
      const rows = db
        .update(receipts)
        .set({
          cancelled: true,
          cancelReason: reason,
          version: sql`${receipts.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(receipts.id, id), eq(receipts.version, expectedVersion)))
        .returning({ id: receipts.id })
        .all();
      return rows.length === 1;
    },
    activeCount(orderId) {
      return (
        db
          .select({ n: count() })
          .from(receipts)
          .where(and(eq(receipts.purchaseOrderId, orderId), eq(receipts.cancelled, false)))
          .get()?.n ?? 0
      );
    },
    acceptedByLine(orderId) {
      return db
        .select({
          lineId: receiptLines.purchaseOrderLineId,
          accepted: sql<number>`coalesce(sum(${receiptLines.accepted}), 0)`,
          firstAcceptedOn: sql<
            string | null
          >`min(CASE WHEN ${receiptLines.accepted} > 0 THEN ${receipts.receivedOn} END)`,
        })
        .from(receiptLines)
        .innerJoin(receipts, eq(receipts.id, receiptLines.receiptId))
        .where(and(eq(receipts.purchaseOrderId, orderId), eq(receipts.cancelled, false)))
        .groupBy(receiptLines.purchaseOrderLineId)
        .all();
    },
    scheduled(filter): ScheduledLine[] {
      return db
        .select({
          purchaseOrderId: purchaseOrders.id,
          purchaseOrderNumber: purchaseOrders.number,
          supplierName: sql<string>`coalesce(${partners.name}, '')`,
          orderedOn: purchaseOrders.orderedOn,
          deliveryRequestedOn: purchaseOrders.deliveryRequestedOn,
          destinationKind: purchaseOrders.destinationKind,
          destinationLocationId: purchaseOrders.destinationLocationId,
          destinationName: sql<string>`coalesce(${locations.name}, ${customers.name}, substr(${purchaseOrders.destinationAddress}, 1, 40), '')`,
          lineId: purchaseOrderLines.id,
          itemCode: sql<string>`coalesce(${items.code}, '')`,
          itemName: sql<string>`coalesce(${items.name}, '（不明な商品）')`,
          purchaseUnitName: sql<string>`coalesce(${items.purchaseUnitName}, '')`,
          quantity: purchaseOrderLines.quantity,
          receivedQuantity: purchaseOrderLines.receivedQuantity,
          closed: purchaseOrderLines.closed,
        })
        .from(purchaseOrderLines)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
        .leftJoin(partners, eq(partners.id, purchaseOrders.supplierId))
        .leftJoin(locations, eq(locations.id, purchaseOrders.destinationLocationId))
        .leftJoin(customers, eq(customers.id, purchaseOrders.destinationCustomerId))
        .leftJoin(items, eq(items.id, purchaseOrderLines.itemId))
        .where(
          and(
            eq(purchaseOrders.status, "ordered"),
            eq(purchaseOrderLines.closed, false),
            sql`${purchaseOrderLines.receivedQuantity} < ${purchaseOrderLines.quantity}`,
            filter.locationId
              ? eq(purchaseOrders.destinationLocationId, filter.locationId)
              : undefined,
            filter.deliveryOn
              ? eq(purchaseOrders.deliveryRequestedOn, filter.deliveryOn)
              : undefined,
          ),
        )
        .orderBy(
          sql`CASE WHEN ${purchaseOrders.destinationKind} = 'location' THEN 0 ELSE 1 END`,
          asc(locations.displayOrder),
          asc(locations.name),
          sql`${purchaseOrders.deliveryRequestedOn} IS NULL`,
          asc(purchaseOrders.deliveryRequestedOn),
          asc(purchaseOrders.orderedOn),
          asc(purchaseOrders.number),
          asc(purchaseOrderLines.lineNo),
        )
        .all();
    },
  };
}
