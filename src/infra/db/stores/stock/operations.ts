import { and, asc, count, desc, eq, gte, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type {
  StockOperationFilter,
  StockOperationStore,
  StockOperationSummary,
} from "../../../../usecases/stock/operations.port";
import { auditInsert, type Db } from "../../client";
import {
  employees,
  items,
  locations,
  stockOperationLines,
  stockOperations,
  stores,
} from "../../schema";
import { insertBatches } from "../../sql-helpers";

const toLocations = alias(locations, "to_locations");

const lineCount = sql<number>`(select count(*) from ${stockOperationLines} where ${stockOperationLines.operationId} = ${stockOperations.id})`;

const summaryColumns = {
  op: stockOperations,
  locationName: locations.name,
  toLocationName: toLocations.name,
  storeName: stores.name,
  createdByName: employees.name,
  lineCount,
};

type SummaryRow = {
  op: typeof stockOperations.$inferSelect;
  locationName: string | null;
  toLocationName: string | null;
  storeName: string | null;
  createdByName: string | null;
  lineCount: number;
};

function toSummary(r: SummaryRow): StockOperationSummary {
  return {
    id: r.op.id,
    number: r.op.number,
    kind: r.op.kind,
    operationDate: r.op.operationDate,
    locationId: r.op.locationId,
    toLocationId: r.op.toLocationId,
    storeId: r.op.storeId,
    adjustmentReason: r.op.adjustmentReason,
    memo: r.op.memo,
    locationName: r.locationName ?? "",
    toLocationName: r.toLocationName,
    storeName: r.storeName,
    lineCount: r.lineCount,
    createdAt: r.op.createdAt,
    createdByName: r.createdByName,
  };
}

/** 明細の行の列数（INSERT を分ける単位の計算に使う） */
const LINE_COLUMNS = 4;

function where(filter: StockOperationFilter): SQL | undefined {
  return and(
    filter.kind ? eq(stockOperations.kind, filter.kind) : undefined,
    filter.locationId
      ? or(
          eq(stockOperations.locationId, filter.locationId),
          eq(stockOperations.toLocationId, filter.locationId),
        )
      : undefined,
    filter.from ? gte(stockOperations.operationDate, filter.from) : undefined,
    filter.to ? lte(stockOperations.operationDate, filter.to) : undefined,
  );
}

export function stockOperationStore(db: Db): StockOperationStore {
  const base = () =>
    db
      .select(summaryColumns)
      .from(stockOperations)
      .leftJoin(locations, eq(locations.id, stockOperations.locationId))
      .leftJoin(toLocations, eq(toLocations.id, stockOperations.toLocationId))
      .leftJoin(stores, eq(stores.id, stockOperations.storeId))
      .leftJoin(employees, eq(employees.id, stockOperations.createdBy));

  return {
    insert(id, fields, lines, meta) {
      db.insert(stockOperations)
        .values({ id, ...fields, ...auditInsert(meta) })
        .run();
      for (const batch of insertBatches(lines, LINE_COLUMNS)) {
        db.insert(stockOperationLines)
          .values(
            batch.map((l) => ({
              id: l.id,
              operationId: id,
              itemId: l.itemId,
              quantity: l.quantity,
            })),
          )
          .run();
      }
    },
    get(id) {
      const r = base().where(eq(stockOperations.id, id)).get();
      if (!r) return undefined;
      const lines = db
        .select({
          itemId: stockOperationLines.itemId,
          quantity: stockOperationLines.quantity,
          itemCode: items.code,
          itemName: items.name,
          salesUnitName: items.salesUnitName,
        })
        .from(stockOperationLines)
        .innerJoin(items, eq(items.id, stockOperationLines.itemId))
        .where(eq(stockOperationLines.operationId, id))
        .orderBy(asc(stockOperationLines.id))
        .all();
      return { ...toSummary(r), lines };
    },
    list(filter, page, pageSize) {
      const w = where(filter);
      const total = db.select({ n: count() }).from(stockOperations).where(w).get()?.n ?? 0;
      const rows = base()
        .where(w)
        .orderBy(desc(stockOperations.operationDate), desc(stockOperations.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows: rows.map(toSummary), total, page, pageSize };
    },
  };
}
