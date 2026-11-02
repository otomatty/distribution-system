/**
 * 売上・仕入の集計の読み出し（usecases/reports/monthly.port.ts）。
 * 月（業務日の先頭7文字）× 行でまとめて、DB の中で足す。明細の金額の端数処理は domain の sumLineAmounts が行う
 * （ここでは単価 × 数量と、その100で割った余りを足すだけ）。
 * 期間の絞り込みは発送日・返品日・入荷日のインデックスを使う（docs/performance.md）。
 */
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import type { ReportAxis } from "../../../../domain/reports";
import type {
  ReportLabel,
  ReportRange,
  ReportStore,
} from "../../../../usecases/reports/monthly.port";
import type { Db } from "../../client";
import {
  items,
  partners,
  purchaseOrders,
  purchaseReturnLines,
  purchaseReturns,
  receiptLines,
  receipts,
  salesCharges,
  salesOrderLines,
  salesOrders,
  salesReturnLines,
  salesReturns,
  shipments,
} from "../../schema";
import { inList } from "../../sql-helpers";

const NO_KEY = sql<string | null>`NULL`;

/** 業務日（YYYY-MM-DD）の列 */
type DateColumn = AnySQLiteColumn<{ data: string }>;

function month(column: DateColumn): SQL<string> {
  return sql<string>`substr(${column}, 1, 7)`;
}

function inRange(column: DateColumn, range: ReportRange): SQL | undefined {
  return and(gte(column, range.from), lte(column, range.to));
}

export function reportStore(db: Db): ReportStore {
  return {
    shippedLines(range, axis) {
      const product = sql`(${salesOrderLines.unitPriceCenti} * ${salesOrderLines.quantity})`;
      const key =
        axis === "customer"
          ? sql<string | null>`${salesOrders.customerId}`
          : axis === "item"
            ? sql<string | null>`${salesOrderLines.itemId}`
            : axis === "supplier"
              ? sql<string | null>`${items.supplierId}`
              : NO_KEY;
      const shippedMonth = month(shipments.shippedOn);
      let query = db
        .select({
          month: shippedMonth,
          key,
          centi: sql<number>`coalesce(sum(${product}), 0)`,
          remainder: sql<number>`coalesce(sum(${product} % 100), 0)`,
          fractional: sql<number>`coalesce(sum(${product} % 100 > 0), 0)`,
          halfOrMore: sql<number>`coalesce(sum(${product} % 100 >= 50), 0)`,
        })
        .from(shipments)
        .innerJoin(salesOrderLines, eq(salesOrderLines.salesOrderId, shipments.salesOrderId))
        .$dynamic();
      if (axis === "customer")
        query = query.innerJoin(salesOrders, eq(salesOrders.id, shipments.salesOrderId));
      if (axis === "supplier") query = query.innerJoin(items, eq(items.id, salesOrderLines.itemId));
      return query
        .where(and(eq(shipments.cancelled, false), inRange(shipments.shippedOn, range)))
        .groupBy(shippedMonth, key)
        .all();
    },

    shippedCharges(range, byCustomer) {
      const shippedMonth = month(shipments.shippedOn);
      const key = byCustomer ? sql<string | null>`${salesOrders.customerId}` : NO_KEY;
      return db
        .select({
          month: shippedMonth,
          key,
          amount: sql<number>`coalesce(sum(${salesCharges.quantity} * ${salesCharges.unitAmount}), 0)`,
        })
        .from(shipments)
        .innerJoin(salesCharges, eq(salesCharges.salesOrderId, shipments.salesOrderId))
        .innerJoin(salesOrders, eq(salesOrders.id, shipments.salesOrderId))
        .where(and(eq(shipments.cancelled, false), inRange(shipments.shippedOn, range)))
        .groupBy(shippedMonth, key)
        .all();
    },

    salesReturns(range, axis) {
      const returnedMonth = month(salesReturns.returnedOn);
      const key =
        axis === "customer"
          ? sql<string | null>`${salesReturns.customerId}`
          : axis === "item"
            ? sql<string | null>`${salesReturnLines.itemId}`
            : axis === "supplier"
              ? sql<string | null>`${items.supplierId}`
              : NO_KEY;
      let query = db
        .select({
          month: returnedMonth,
          key,
          amount: sql<number>`coalesce(sum(${salesReturnLines.amount}), 0)`,
        })
        .from(salesReturns)
        .innerJoin(salesReturnLines, eq(salesReturnLines.salesReturnId, salesReturns.id))
        .$dynamic();
      if (axis === "supplier")
        query = query.innerJoin(items, eq(items.id, salesReturnLines.itemId));
      return query
        .where(and(eq(salesReturns.cancelled, false), inRange(salesReturns.returnedOn, range)))
        .groupBy(returnedMonth, key)
        .all();
    },

    receipts(range, axis) {
      const receivedMonth = month(receipts.receivedOn);
      const key =
        axis === "supplier"
          ? sql<string | null>`${purchaseOrders.supplierId}`
          : axis === "item"
            ? sql<string | null>`${receiptLines.itemId}`
            : NO_KEY;
      let query = db
        .select({
          month: receivedMonth,
          key,
          amount: sql<number>`coalesce(sum(${receiptLines.amount}), 0)`,
        })
        .from(receipts)
        .innerJoin(receiptLines, eq(receiptLines.receiptId, receipts.id))
        .$dynamic();
      if (axis === "supplier")
        query = query.innerJoin(purchaseOrders, eq(purchaseOrders.id, receipts.purchaseOrderId));
      return query
        .where(and(eq(receipts.cancelled, false), inRange(receipts.receivedOn, range)))
        .groupBy(receivedMonth, key)
        .all();
    },

    purchaseReturns(range, axis) {
      const returnedMonth = month(purchaseReturns.returnedOn);
      const key =
        axis === "supplier"
          ? sql<string | null>`${purchaseReturns.supplierId}`
          : axis === "item"
            ? sql<string | null>`${purchaseReturnLines.itemId}`
            : NO_KEY;
      return db
        .select({
          month: returnedMonth,
          key,
          amount: sql<number>`coalesce(sum(${purchaseReturnLines.amount}), 0)`,
        })
        .from(purchaseReturns)
        .innerJoin(
          purchaseReturnLines,
          eq(purchaseReturnLines.purchaseReturnId, purchaseReturns.id),
        )
        .where(
          and(eq(purchaseReturns.cancelled, false), inRange(purchaseReturns.returnedOn, range)),
        )
        .groupBy(returnedMonth, key)
        .all();
    },

    labels(axis: ReportAxis, keys): ReportLabel[] {
      if (keys.length === 0) return [];
      if (axis === "item")
        return db
          .select({ key: items.id, code: items.code, name: items.name })
          .from(items)
          .where(inList(items.id, keys))
          .all();
      return db
        .select({ key: partners.id, code: sql<string | null>`NULL`, name: partners.name })
        .from(partners)
        .where(inList(partners.id, keys))
        .all();
    },
  };
}
