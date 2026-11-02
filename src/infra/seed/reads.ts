/** テストデータの投入で、次の操作を決めるために業務 DB を読む（書き込みはユースケースを通す） */
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { inList } from "../db/sql-helpers";

export interface Balance {
  readonly onHand: number;
  readonly allocated: number;
}

const ZERO: Balance = { onHand: 0, allocated: 0 };

/** 商品×保管場所の在庫（記録がなければ 0） */
export class Balances {
  private readonly map = new Map<string, Balance>();

  constructor(
    rows: readonly { itemId: string; locationId: string; onHand: number; allocated: number }[],
  ) {
    for (const r of rows) this.map.set(`${r.itemId}:${r.locationId}`, r);
  }

  get(itemId: string, locationId: string): Balance {
    return this.map.get(`${itemId}:${locationId}`) ?? ZERO;
  }

  /** すべての保管場所の出荷可能数の合計 */
  availableEverywhere(itemId: string, locationIds: readonly string[]): number {
    return locationIds.reduce((s, l) => {
      const b = this.get(itemId, l);
      return s + b.onHand - b.allocated;
    }, 0);
  }
}

export function loadBalances(db: Db, locationId?: string, itemIds?: readonly string[]): Balances {
  const conds = [
    locationId ? eq(schema.stockBalances.locationId, locationId) : undefined,
    itemIds ? inList(schema.stockBalances.itemId, itemIds) : undefined,
  ];
  return new Balances(
    db
      .select({
        itemId: schema.stockBalances.itemId,
        locationId: schema.stockBalances.locationId,
        onHand: schema.stockBalances.onHand,
        allocated: schema.stockBalances.allocated,
      })
      .from(schema.stockBalances)
      .where(and(...conds))
      .all(),
  );
}

/** 発注済みで、まだ入荷していない数（販売単位、商品ごと。納入先が保管場所の発注だけ） */
export function incomingByItem(db: Db): Map<string, number> {
  const rows = db
    .select({
      itemId: schema.purchaseOrderLines.itemId,
      units: sql<number>`sum((${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity}) * ${schema.purchaseOrderLines.unitsPerPurchaseUnit})`,
    })
    .from(schema.purchaseOrderLines)
    .innerJoin(
      schema.purchaseOrders,
      eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
    )
    .where(
      and(
        inList(schema.purchaseOrders.status, ["draft", "ordered"]),
        eq(schema.purchaseOrders.destinationKind, "location"),
        eq(schema.purchaseOrderLines.closed, false),
      ),
    )
    .groupBy(schema.purchaseOrderLines.itemId)
    .all();
  return new Map(rows.map((r) => [r.itemId, r.units]));
}

export interface OrderLineRow {
  readonly id: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly unitPriceCenti: number;
  readonly priceOverrideReason: string | null;
}

export function salesOrderLines(db: Db, orderId: string): OrderLineRow[] {
  return db
    .select({
      id: schema.salesOrderLines.id,
      itemId: schema.salesOrderLines.itemId,
      quantity: schema.salesOrderLines.quantity,
      unitPriceCenti: schema.salesOrderLines.unitPriceCenti,
      priceOverrideReason: schema.salesOrderLines.priceOverrideReason,
    })
    .from(schema.salesOrderLines)
    .where(eq(schema.salesOrderLines.salesOrderId, orderId))
    .orderBy(schema.salesOrderLines.lineNo)
    .all();
}

export function purchaseOrderLines(db: Db, orderId: string) {
  return db
    .select({
      id: schema.purchaseOrderLines.id,
      itemId: schema.purchaseOrderLines.itemId,
      quantity: schema.purchaseOrderLines.quantity,
      receivedQuantity: schema.purchaseOrderLines.receivedQuantity,
      closed: schema.purchaseOrderLines.closed,
      unitsPerPurchaseUnit: schema.purchaseOrderLines.unitsPerPurchaseUnit,
    })
    .from(schema.purchaseOrderLines)
    .where(eq(schema.purchaseOrderLines.purchaseOrderId, orderId))
    .orderBy(schema.purchaseOrderLines.lineNo)
    .all();
}

export function salesOrderVersion(db: Db, id: string): number {
  return (
    db
      .select({ version: schema.salesOrders.version })
      .from(schema.salesOrders)
      .where(eq(schema.salesOrders.id, id))
      .get()?.version ?? 1
  );
}
