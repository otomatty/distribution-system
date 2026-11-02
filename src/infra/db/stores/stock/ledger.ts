import { and, asc, count, eq, gte, isNotNull, lt, lte, not, or, sql, type SQL } from "drizzle-orm";

import {
  isStockReason,
  isStockSourceType,
  type StockReason,
  type StockSourceType,
} from "../../../../domain/stock";
import type {
  LedgerEntry,
  LedgerListRow,
  StockListFilter,
  StockListRow,
  StockStore,
} from "../../../../usecases/stock/ledger.port";
import { likePattern, type Db } from "../../client";
import {
  employees,
  genres,
  items,
  locations,
  partners,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReturns,
  receipts,
  salesReturns,
  shipments,
  stockBalances,
  stockLedger,
  stockOperations,
} from "../../schema";
import { inList, insertBatches } from "../../sql-helpers";

/** 台帳に保存された理由・発生元を型に戻す（台帳はこのモジュールからしか書かないので、外れることはない） */
function reasonOf(value: string): StockReason {
  if (!isStockReason(value)) throw new Error(`在庫台帳に不明な理由があります: ${value}`);
  return value;
}

function sourceTypeOf(value: string): StockSourceType {
  if (!isStockSourceType(value)) throw new Error(`在庫台帳に不明な発生元があります: ${value}`);
  return value;
}

function toEntry(r: typeof stockLedger.$inferSelect): LedgerEntry {
  return {
    id: r.id,
    occurredAt: r.occurredAt,
    businessDate: r.businessDate,
    itemId: r.itemId,
    locationId: r.locationId,
    quantity: r.quantity,
    reason: reasonOf(r.reason),
    sourceType: sourceTypeOf(r.sourceType),
    sourceId: r.sourceId,
    reversesId: r.reversesId,
    memo: r.memo,
    createdBy: r.createdBy,
  };
}

const listColumns = {
  itemId: stockBalances.itemId,
  locationId: stockBalances.locationId,
  onHand: stockBalances.onHand,
  allocated: stockBalances.allocated,
  itemCode: items.code,
  itemName: items.name,
  jan: items.jan,
  salesUnitName: items.salesUnitName,
  genreName: genres.name,
  discontinued: items.discontinued,
  reorderEnabled: items.reorderEnabled,
  reorderPoint: items.reorderPoint,
  locationName: locations.name,
};

/** 台帳の行の列数（INSERT を分ける単位の計算に使う） */
const LEDGER_COLUMNS = 12;

function listWhere(filter: StockListFilter): SQL | undefined {
  const conds: SQL[] = [
    // 取扱終了で在庫も引当もない行は出さない
    not(
      and(
        eq(items.discontinued, true),
        eq(stockBalances.onHand, 0),
        eq(stockBalances.allocated, 0),
      ) ?? sql`0`,
    ),
  ];
  if (filter.q) {
    const p = likePattern(filter.q);
    const c = or(
      sql`${items.name} LIKE ${p} ESCAPE '\\'`,
      sql`${items.code} LIKE ${p} ESCAPE '\\'`,
      sql`${items.jan} LIKE ${p} ESCAPE '\\'`,
    );
    if (c) conds.push(c);
  }
  if (filter.locationId) conds.push(eq(stockBalances.locationId, filter.locationId));
  if (filter.genreId) conds.push(eq(items.genreId, filter.genreId));
  if (filter.itemIds) conds.push(inList(stockBalances.itemId, filter.itemIds));
  return and(...conds);
}

// CSV はページごとに読むので、最後に保管場所の ID で順を決めきる（同じ名前・表示順の保管場所があっても行が重ならない）
const listOrder = [
  asc(items.code),
  asc(locations.displayOrder),
  asc(locations.name),
  asc(stockBalances.locationId),
];

export function stockStore(db: Db): StockStore {
  const listBase = () =>
    db
      .select(listColumns)
      .from(stockBalances)
      .innerJoin(items, eq(items.id, stockBalances.itemId))
      .innerJoin(locations, eq(locations.id, stockBalances.locationId))
      .leftJoin(genres, eq(genres.id, items.genreId));

  return {
    balance(itemId, locationId) {
      const r = db
        .select({ onHand: stockBalances.onHand, allocated: stockBalances.allocated })
        .from(stockBalances)
        .where(and(eq(stockBalances.itemId, itemId), eq(stockBalances.locationId, locationId)))
        .get();
      return r ?? { onHand: 0, allocated: 0 };
    },
    balancesAt(locationId, itemIds) {
      if (itemIds && itemIds.length === 0) return [];
      return db
        .select({
          itemId: stockBalances.itemId,
          locationId: stockBalances.locationId,
          onHand: stockBalances.onHand,
          allocated: stockBalances.allocated,
        })
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.locationId, locationId),
            itemIds ? inList(stockBalances.itemId, itemIds) : undefined,
          ),
        )
        .all();
    },
    balancesOfItem(itemId) {
      return db
        .select({
          itemId: stockBalances.itemId,
          locationId: stockBalances.locationId,
          onHand: stockBalances.onHand,
          allocated: stockBalances.allocated,
        })
        .from(stockBalances)
        .innerJoin(locations, eq(locations.id, stockBalances.locationId))
        .where(eq(stockBalances.itemId, itemId))
        .orderBy(asc(locations.displayOrder), asc(locations.name))
        .all();
    },
    saveOnHand(itemId, locationId, onHand, at) {
      db.insert(stockBalances)
        .values({ itemId, locationId, onHand, allocated: 0, updatedAt: at })
        .onConflictDoUpdate({
          target: [stockBalances.itemId, stockBalances.locationId],
          set: { onHand, updatedAt: at },
        })
        .run();
    },
    saveAllocated(itemId, locationId, allocated, at) {
      db.insert(stockBalances)
        .values({ itemId, locationId, onHand: 0, allocated, updatedAt: at })
        .onConflictDoUpdate({
          target: [stockBalances.itemId, stockBalances.locationId],
          set: { allocated, updatedAt: at },
        })
        .run();
    },
    append(entries) {
      for (const batch of insertBatches(entries, LEDGER_COLUMNS)) {
        db.insert(stockLedger).values(batch).run();
      }
    },
    entriesBySource(sourceType, sourceId) {
      return db
        .select()
        .from(stockLedger)
        .where(and(eq(stockLedger.sourceType, sourceType), eq(stockLedger.sourceId, sourceId)))
        .orderBy(asc(stockLedger.id))
        .all()
        .map(toEntry);
    },

    listBalances(filter, page, pageSize) {
      const where = listWhere(filter);
      const total =
        db
          .select({ n: count() })
          .from(stockBalances)
          .innerJoin(items, eq(items.id, stockBalances.itemId))
          .innerJoin(locations, eq(locations.id, stockBalances.locationId))
          .where(where)
          .get()?.n ?? 0;
      const rows: StockListRow[] = listBase()
        .where(where)
        .orderBy(...listOrder)
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows, total, page, pageSize };
    },
    reorderCandidates() {
      return db
        .select({
          itemId: items.id,
          itemCode: items.code,
          itemName: items.name,
          salesUnitName: items.salesUnitName,
          supplierId: items.supplierId,
          supplierName: sql<string>`coalesce(${partners.name}, '')`,
          reorderPoint: items.reorderPoint,
          onHand: sql<number>`coalesce(sum(${stockBalances.onHand}), 0)`,
          allocated: sql<number>`coalesce(sum(${stockBalances.allocated}), 0)`,
        })
        .from(items)
        .leftJoin(partners, eq(partners.id, items.supplierId))
        .leftJoin(stockBalances, eq(stockBalances.itemId, items.id))
        .where(and(eq(items.reorderEnabled, true), eq(items.discontinued, false)))
        .groupBy(items.id)
        .orderBy(asc(items.code))
        .all();
    },
    openPurchaseLines(itemIds) {
      if (itemIds && itemIds.length === 0) return [];
      return db
        .select({
          itemId: purchaseOrderLines.itemId,
          locationId: purchaseOrders.destinationLocationId,
          quantity: purchaseOrderLines.quantity,
          receivedQuantity: purchaseOrderLines.receivedQuantity,
          closed: purchaseOrderLines.closed,
          unitsPerPurchaseUnit: purchaseOrderLines.unitsPerPurchaseUnit,
        })
        .from(purchaseOrderLines)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
        .where(
          and(
            eq(purchaseOrders.status, "ordered"),
            eq(purchaseOrders.destinationKind, "location"),
            isNotNull(purchaseOrders.destinationLocationId),
            eq(purchaseOrderLines.closed, false),
            itemIds ? inList(purchaseOrderLines.itemId, itemIds) : undefined,
          ),
        )
        .all()
        .flatMap((r) => (r.locationId === null ? [] : [{ ...r, locationId: r.locationId }]));
    },
    ledger(itemId, filter, page, pageSize) {
      const scope = and(
        eq(stockLedger.itemId, itemId),
        filter.locationId ? eq(stockLedger.locationId, filter.locationId) : undefined,
      );
      // 残高は、絞り込む前の（商品・保管場所の）すべての行を業務日・記録順に足し上げて求める
      const scoped = db
        .select({
          id: stockLedger.id,
          occurredAt: stockLedger.occurredAt,
          businessDate: stockLedger.businessDate,
          itemId: stockLedger.itemId,
          locationId: stockLedger.locationId,
          quantity: stockLedger.quantity,
          reason: stockLedger.reason,
          sourceType: stockLedger.sourceType,
          sourceId: stockLedger.sourceId,
          reversesId: stockLedger.reversesId,
          memo: stockLedger.memo,
          createdBy: stockLedger.createdBy,
          balance:
            sql<number>`sum(${stockLedger.quantity}) over (order by ${stockLedger.businessDate}, ${stockLedger.id} rows between unbounded preceding and current row)`.as(
              "balance",
            ),
        })
        .from(stockLedger)
        .where(scope)
        .as("scoped");
      const where = and(
        filter.from ? gte(scoped.businessDate, filter.from) : undefined,
        filter.to ? lte(scoped.businessDate, filter.to) : undefined,
        filter.reason ? eq(scoped.reason, filter.reason) : undefined,
      );
      const opening = filter.from
        ? (db
            .select({ sum: sql<number>`coalesce(sum(${stockLedger.quantity}), 0)` })
            .from(stockLedger)
            .where(and(scope, lt(stockLedger.businessDate, filter.from)))
            .get()?.sum ?? 0)
        : 0;
      const total = db.select({ n: count() }).from(scoped).where(where).get()?.n ?? 0;
      const rows = db
        .select({
          entry: {
            id: scoped.id,
            occurredAt: scoped.occurredAt,
            businessDate: scoped.businessDate,
            itemId: scoped.itemId,
            locationId: scoped.locationId,
            quantity: scoped.quantity,
            reason: scoped.reason,
            sourceType: scoped.sourceType,
            sourceId: scoped.sourceId,
            reversesId: scoped.reversesId,
            memo: scoped.memo,
            createdBy: scoped.createdBy,
            balance: scoped.balance,
          },
          locationName: locations.name,
          createdByName: employees.name,
          // 発生元の伝票は種類ごとに別の表にある。種類と ID で1つだけが結びつく
          sourceNumber: sql<
            string | null
          >`coalesce(${stockOperations.number}, ${receipts.number}, ${purchaseReturns.number}, ${shipments.deliveryNoteNumber}, ${salesReturns.number})`,
          sourceOwnerId: sql<
            string | null
          >`coalesce(${stockOperations.id}, ${receipts.purchaseOrderId}, ${purchaseReturns.purchaseOrderId}, ${shipments.salesOrderId}, ${salesReturns.salesOrderId})`,
          reversed: sql<number>`exists(select 1 from ${stockLedger} where ${stockLedger.reversesId} = ${scoped.id})`,
        })
        .from(scoped)
        .innerJoin(locations, eq(locations.id, scoped.locationId))
        .leftJoin(employees, eq(employees.id, scoped.createdBy))
        .leftJoin(
          stockOperations,
          and(eq(scoped.sourceType, "stock_operation"), eq(stockOperations.id, scoped.sourceId)),
        )
        .leftJoin(receipts, and(eq(scoped.sourceType, "receipt"), eq(receipts.id, scoped.sourceId)))
        .leftJoin(
          purchaseReturns,
          and(eq(scoped.sourceType, "purchase_return"), eq(purchaseReturns.id, scoped.sourceId)),
        )
        .leftJoin(
          shipments,
          and(eq(scoped.sourceType, "shipment"), eq(shipments.id, scoped.sourceId)),
        )
        .leftJoin(
          salesReturns,
          and(eq(scoped.sourceType, "sales_return"), eq(salesReturns.id, scoped.sourceId)),
        )
        .where(where)
        .orderBy(asc(scoped.businessDate), asc(scoped.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all()
        .map(({ entry: e, ...r }): LedgerListRow => ({
          id: e.id,
          occurredAt: e.occurredAt,
          businessDate: e.businessDate,
          itemId: e.itemId,
          locationId: e.locationId,
          quantity: e.quantity,
          reason: reasonOf(e.reason),
          sourceType: sourceTypeOf(e.sourceType),
          sourceId: e.sourceId,
          reversesId: e.reversesId,
          memo: e.memo,
          createdBy: e.createdBy,
          balance: e.balance,
          locationName: r.locationName,
          createdByName: r.createdByName,
          sourceNumber: r.sourceNumber,
          sourceOwnerId: r.sourceOwnerId,
          reversed: r.reversed === 1,
        }));
      return { opening, rows: { rows, total, page, pageSize } };
    },
  };
}
