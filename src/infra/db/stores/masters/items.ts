import { and, asc, count, eq, or, sql, type SQL } from "drizzle-orm";

import type { ItemFilter, ItemRecord, ItemStore } from "../../../../usecases/masters/items.port";
import { auditInsert, likePattern, type Db } from "../../client";
import {
  disposalLines,
  genres,
  items,
  partners,
  purchaseOrderLines,
  purchaseReturnLines,
  receiptLines,
  salesOrderLines,
  salesReturnLines,
  stockBalances,
  stockLedger,
  stockOperationLines,
} from "../../schema";
import { inList, notInList } from "../../sql-helpers";

const columns = {
  item: items,
  supplierName: partners.name,
  genreName: genres.name,
};

type Row = {
  item: typeof items.$inferSelect;
  supplierName: string | null;
  genreName: string | null;
};

function toRecord({ item: r, supplierName, genreName }: Row): ItemRecord {
  return {
    id: r.id,
    code: r.code,
    jan: r.jan,
    name: r.name,
    supplierId: r.supplierId,
    supplierName: supplierName ?? "",
    genreId: r.genreId,
    genreName,
    temperatureZone: r.temperatureZone,
    taxCategory: r.taxCategory,
    purchaseUnitName: r.purchaseUnitName,
    salesUnitName: r.salesUnitName,
    unitsPerPurchaseUnit: r.unitsPerPurchaseUnit,
    purchasePriceCenti: r.purchasePriceCenti,
    salesPriceCenti: r.salesPriceCenti,
    purchaseMinLot: r.purchaseMinLot,
    salesMinLot: r.salesMinLot,
    leadTimeDays: r.leadTimeDays,
    reorderEnabled: r.reorderEnabled,
    reorderPoint: r.reorderPoint,
    purchaseShippingNote: r.purchaseShippingNote,
    salesShippingNote: r.salesShippingNote,
    inputPriceOnOrder: r.inputPriceOnOrder,
    memo: r.memo,
    discontinued: r.discontinued,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function where(filter: ItemFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.q) {
    const p = likePattern(filter.q);
    const c = or(
      sql`${items.name} LIKE ${p} ESCAPE '\\'`,
      sql`${items.code} LIKE ${p} ESCAPE '\\'`,
      sql`${items.jan} LIKE ${p} ESCAPE '\\'`,
    );
    if (c) conds.push(c);
  }
  if (filter.supplierId) conds.push(eq(items.supplierId, filter.supplierId));
  if (filter.genreId) conds.push(eq(items.genreId, filter.genreId));
  if (!filter.includeDiscontinued) conds.push(eq(items.discontinued, false));
  if (filter.excludeIds && filter.excludeIds.length > 0)
    conds.push(notInList(items.id, filter.excludeIds));
  return conds.length > 0 ? and(...conds) : undefined;
}

export function itemStore(db: Db): ItemStore {
  const base = () =>
    db
      .select(columns)
      .from(items)
      .leftJoin(partners, eq(partners.id, items.supplierId))
      .leftJoin(genres, eq(genres.id, items.genreId));

  return {
    get(id) {
      const r = base().where(eq(items.id, id)).get();
      return r ? toRecord(r) : undefined;
    },
    getMany(ids) {
      if (ids.length === 0) return [];
      const rows = base().where(inList(items.id, ids)).all().map(toRecord);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return [...new Set(ids)].flatMap((id) => {
        const r = byId.get(id);
        return r ? [r] : [];
      });
    },
    findByCode(code) {
      const r = base().where(eq(items.code, code)).get();
      return r ? toRecord(r) : undefined;
    },
    findByCodes(codes) {
      if (codes.length === 0) return [];
      return base().where(inList(items.code, codes)).all().map(toRecord);
    },
    list(filter, page, pageSize) {
      const w = where(filter);
      const total = db.select({ n: count() }).from(items).where(w).get()?.n ?? 0;
      const rows = base()
        .where(w)
        .orderBy(asc(items.code))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows: rows.map(toRecord), total, page, pageSize };
    },
    insert(id, fields, meta) {
      db.insert(items)
        .values({ id, ...fields, discontinued: false, ...auditInsert(meta) })
        .run();
    },
    update(id, expectedVersion, patch, meta) {
      const rows = db
        .update(items)
        .set({
          ...patch,
          version: sql`${items.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(items.id, id), eq(items.version, expectedVersion)))
        .returning({ id: items.id })
        .all();
      return rows.length === 1;
    },
    isUsed(id) {
      const checks = [
        db
          .select({ id: stockLedger.id })
          .from(stockLedger)
          .where(eq(stockLedger.itemId, id))
          .limit(1)
          .get(),
        db
          .select({ id: stockBalances.itemId })
          .from(stockBalances)
          .where(eq(stockBalances.itemId, id))
          .limit(1)
          .get(),
        db
          .select({ id: purchaseOrderLines.id })
          .from(purchaseOrderLines)
          .where(eq(purchaseOrderLines.itemId, id))
          .limit(1)
          .get(),
        db
          .select({ id: receiptLines.id })
          .from(receiptLines)
          .where(eq(receiptLines.itemId, id))
          .limit(1)
          .get(),
        db
          .select({ id: purchaseReturnLines.id })
          .from(purchaseReturnLines)
          .where(eq(purchaseReturnLines.itemId, id))
          .limit(1)
          .get(),
        db
          .select({ id: salesOrderLines.id })
          .from(salesOrderLines)
          .where(eq(salesOrderLines.itemId, id))
          .limit(1)
          .get(),
        db
          .select({ id: salesReturnLines.id })
          .from(salesReturnLines)
          .where(eq(salesReturnLines.itemId, id))
          .limit(1)
          .get(),
        db
          .select({ id: disposalLines.id })
          .from(disposalLines)
          .where(eq(disposalLines.itemId, id))
          .limit(1)
          .get(),
        db
          .select({ id: stockOperationLines.id })
          .from(stockOperationLines)
          .where(eq(stockOperationLines.itemId, id))
          .limit(1)
          .get(),
      ];
      return checks.some((c) => c !== undefined);
    },
    delete(id, expectedVersion) {
      const rows = db
        .delete(items)
        .where(and(eq(items.id, id), eq(items.version, expectedVersion)))
        .returning({ id: items.id })
        .all();
      return rows.length === 1;
    },
  };
}
