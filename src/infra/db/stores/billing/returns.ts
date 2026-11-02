import { and, asc, desc, eq, isNull, lte, sql, sum, type SQL } from "drizzle-orm";

import type {
  SalesReturnLineRecord,
  SalesReturnRecord,
  SalesReturnStore,
} from "../../../../usecases/billing/returns.port";
import { auditInsert, type Db } from "../../client";
import {
  customerPayments,
  employees,
  invoices,
  items,
  locations,
  partners,
  salesOrders,
  salesReturnLines,
  salesReturns,
} from "../../schema";
import { inList, insertBatches } from "../../sql-helpers";

/** 返品伝票の明細の1行あたりの列数（INSERT を分ける単位の計算に使う） */
const LINE_COLUMNS = 10;

export function salesReturnStore(db: Db): SalesReturnStore {
  /** 条件に合う返品伝票と明細を読む（並びは orderBy のとおり） */
  function load(where: SQL | undefined, orderBy: SQL[], limit?: number): SalesReturnRecord[] {
    const query = db
      .select({
        ret: salesReturns,
        salesOrderNumber: salesOrders.number,
        customerName: partners.name,
        invoiceNumber: invoices.number,
        invoiceStatus: invoices.status,
        createdByName: employees.name,
        creditPaymentId: customerPayments.id,
      })
      .from(salesReturns)
      .innerJoin(salesOrders, eq(salesOrders.id, salesReturns.salesOrderId))
      .innerJoin(partners, eq(partners.id, salesReturns.customerId))
      .leftJoin(invoices, eq(invoices.id, salesReturns.invoiceId))
      // 返還請求書で精算した返品伝票の、取り消していない返還額（1件だけ。発行と取消で守る）
      .leftJoin(
        customerPayments,
        and(
          eq(customerPayments.salesReturnId, salesReturns.id),
          eq(customerPayments.cancelled, false),
        ),
      )
      .leftJoin(employees, eq(employees.id, salesReturns.createdBy))
      .where(where)
      .orderBy(...orderBy);
    const heads = limit === undefined ? query.all() : query.limit(limit).all();
    if (heads.length === 0) return [];
    const lines = db
      .select({
        salesReturnId: salesReturnLines.salesReturnId,
        id: salesReturnLines.id,
        salesOrderLineId: salesReturnLines.salesOrderLineId,
        itemId: salesReturnLines.itemId,
        itemCode: items.code,
        itemName: items.name,
        unitName: items.salesUnitName,
        quantity: salesReturnLines.quantity,
        restock: salesReturnLines.restock,
        locationId: salesReturnLines.locationId,
        locationName: locations.name,
        unitPriceCenti: salesReturnLines.unitPriceCenti,
        amount: salesReturnLines.amount,
        taxCategory: salesReturnLines.taxCategory,
      })
      .from(salesReturnLines)
      .innerJoin(items, eq(items.id, salesReturnLines.itemId))
      .leftJoin(locations, eq(locations.id, salesReturnLines.locationId))
      .where(
        inList(
          salesReturnLines.salesReturnId,
          heads.map((h) => h.ret.id),
        ),
      )
      .orderBy(asc(salesReturnLines.id))
      .all();
    const byReturn = new Map<string, SalesReturnLineRecord[]>();
    for (const { salesReturnId, ...l } of lines) {
      const list = byReturn.get(salesReturnId);
      if (list) list.push(l);
      else byReturn.set(salesReturnId, [l]);
    }
    return heads.map((h): SalesReturnRecord => ({
      id: h.ret.id,
      number: h.ret.number,
      salesOrderId: h.ret.salesOrderId,
      salesOrderNumber: h.salesOrderNumber,
      customerId: h.ret.customerId,
      customerName: h.customerName,
      returnedOn: h.ret.returnedOn,
      invoiceId: h.ret.invoiceId,
      invoiceNumber: h.invoiceNumber,
      invoiceStatus: h.invoiceStatus,
      creditNoteNumber: h.ret.creditNoteNumber,
      creditPaymentId: h.creditPaymentId,
      cancelled: h.ret.cancelled,
      memo: h.ret.memo,
      version: h.ret.version,
      createdAt: h.ret.createdAt,
      createdByName: h.createdByName,
      lines: byReturn.get(h.ret.id) ?? [],
    }));
  }

  return {
    get(id) {
      return load(eq(salesReturns.id, id), [asc(salesReturns.id)])[0];
    },
    getMany(ids) {
      if (ids.length === 0) return [];
      const found = new Map(
        load(inList(salesReturns.id, ids), [asc(salesReturns.id)]).map((r) => [r.id, r]),
      );
      return ids.flatMap((id) => {
        const r = found.get(id);
        return r ? [r] : [];
      });
    },
    forOrder(salesOrderId) {
      return load(eq(salesReturns.salesOrderId, salesOrderId), [desc(salesReturns.id)]);
    },
    returnedQuantities(salesOrderId) {
      const rows = db
        .select({
          lineId: salesReturnLines.salesOrderLineId,
          quantity: sum(salesReturnLines.quantity).mapWith(Number),
        })
        .from(salesReturnLines)
        .innerJoin(salesReturns, eq(salesReturns.id, salesReturnLines.salesReturnId))
        .where(and(eq(salesReturns.salesOrderId, salesOrderId), eq(salesReturns.cancelled, false)))
        .groupBy(salesReturnLines.salesOrderLineId)
        .all();
      return new Map(rows.map((r) => [r.lineId, r.quantity]));
    },
    hasActive(salesOrderId) {
      return (
        db
          .select({ id: salesReturns.id })
          .from(salesReturns)
          .where(
            and(eq(salesReturns.salesOrderId, salesOrderId), eq(salesReturns.cancelled, false)),
          )
          .limit(1)
          .get() !== undefined
      );
    },
    insert(record, lines, meta) {
      db.insert(salesReturns)
        .values({
          ...record,
          invoiceId: null,
          creditNoteNumber: null,
          creditNotePdfKey: null,
          cancelled: false,
          ...auditInsert(meta),
        })
        .run();
      const values = lines.map((l) => ({ salesReturnId: record.id, ...l }));
      for (const batch of insertBatches(values, LINE_COLUMNS))
        db.insert(salesReturnLines).values(batch).run();
    },
    cancel(id, expectedVersion, meta) {
      const rows = db
        .update(salesReturns)
        .set({
          cancelled: true,
          version: sql`${salesReturns.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(
          and(
            eq(salesReturns.id, id),
            eq(salesReturns.version, expectedVersion),
            eq(salesReturns.cancelled, false),
          ),
        )
        .returning({ id: salesReturns.id })
        .all();
      return rows.length === 1;
    },
    setCreditNote(id, expectedVersion, number, meta) {
      const rows = db
        .update(salesReturns)
        .set({
          creditNoteNumber: number,
          version: sql`${salesReturns.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(
          and(
            eq(salesReturns.id, id),
            eq(salesReturns.version, expectedVersion),
            isNull(salesReturns.creditNoteNumber),
          ),
        )
        .returning({ id: salesReturns.id })
        .all();
      return rows.length === 1;
    },
    clearCreditNote(id, expectedVersion, meta) {
      const rows = db
        .update(salesReturns)
        .set({
          creditNoteNumber: null,
          version: sql`${salesReturns.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(salesReturns.id, id), eq(salesReturns.version, expectedVersion)))
        .returning({ id: salesReturns.id })
        .all();
      return rows.length === 1;
    },
    unbilled(filter, limit) {
      const conds: SQL[] = [
        eq(salesReturns.customerId, filter.customerId),
        isNull(salesReturns.invoiceId),
        eq(salesReturns.cancelled, false),
        // 返還請求書で精算した返品伝票は、請求書で差し引かない
        isNull(customerPayments.id),
      ];
      if (filter.returnedTo) conds.push(lte(salesReturns.returnedOn, filter.returnedTo));
      return load(and(...conds), [asc(salesReturns.returnedOn), asc(salesReturns.number)], limit);
    },
  };
}
