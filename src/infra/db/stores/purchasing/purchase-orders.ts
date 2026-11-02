import { and, asc, count, desc, eq, gte, isNotNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type {
  PurchaseOrderDetail,
  PurchaseOrderFilter,
  PurchaseOrderLineRecord,
  PurchaseOrderRecord,
  PurchaseOrderStore,
  PurchaseOrderSummary,
} from "../../../../usecases/purchasing/purchase-orders.port";
import { auditInsert, likePattern, type Db } from "../../client";
import {
  employees,
  items,
  locations,
  partners,
  purchaseOrderLines,
  purchaseOrders,
} from "../../schema";
import { insertBatches } from "../../sql-helpers";

const customers = alias(partners, "destination_customer");

/** 明細の列数（INSERT を分ける単位の計算に使う） */
const LINE_COLUMNS = 11;

const recordColumns = {
  id: purchaseOrders.id,
  number: purchaseOrders.number,
  status: purchaseOrders.status,
  supplierId: purchaseOrders.supplierId,
  orderedOn: purchaseOrders.orderedOn,
  supplierContactName: purchaseOrders.supplierContactName,
  destinationKind: purchaseOrders.destinationKind,
  destinationLocationId: purchaseOrders.destinationLocationId,
  destinationCustomerId: purchaseOrders.destinationCustomerId,
  destinationAddress: purchaseOrders.destinationAddress,
  employeeId: purchaseOrders.employeeId,
  deliveryRequestedOn: purchaseOrders.deliveryRequestedOn,
  paymentDueOn: purchaseOrders.paymentDueOn,
  sendMethod: purchaseOrders.sendMethod,
  memo: purchaseOrders.memo,
  subtotal: purchaseOrders.subtotal,
  tax: purchaseOrders.tax,
  total: purchaseOrders.total,
  cancelReason: purchaseOrders.cancelReason,
  confirmedAt: purchaseOrders.confirmedAt,
  version: purchaseOrders.version,
  createdAt: purchaseOrders.createdAt,
  updatedAt: purchaseOrders.updatedAt,
  supplierName: sql<string>`coalesce(${partners.name}, '')`,
  supplierHonorific: sql<string>`coalesce(${partners.honorific}, '御中')`,
  supplierPostalCode: partners.postalCode,
  supplierAddress: partners.address,
  supplierPhone: partners.phone,
  supplierFax: partners.fax,
  destinationPostalCode: sql<
    string | null
  >`coalesce(${locations.postalCode}, ${customers.postalCode})`,
  destinationPlace: sql<string | null>`coalesce(${locations.address}, ${customers.address})`,
  destinationPhone: sql<string | null>`coalesce(${locations.phone}, ${customers.phone})`,
  destinationName: sql<string | null>`coalesce(${locations.name}, ${customers.name})`,
  employeeName: employees.name,
};

function conditions(filter: PurchaseOrderFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.status) conds.push(eq(purchaseOrders.status, filter.status));
  if (filter.supplierId) conds.push(eq(purchaseOrders.supplierId, filter.supplierId));
  if (filter.from) conds.push(gte(purchaseOrders.orderedOn, filter.from));
  if (filter.to) conds.push(lte(purchaseOrders.orderedOn, filter.to));
  if (filter.hasMemo)
    conds.push(and(isNotNull(purchaseOrders.memo), sql`${purchaseOrders.memo} <> ''`) ?? sql`1`);
  if (filter.deliveryBefore) {
    conds.push(eq(purchaseOrders.status, "ordered"));
    conds.push(lt(purchaseOrders.deliveryRequestedOn, filter.deliveryBefore));
  }
  if (filter.q) {
    const p = likePattern(filter.q);
    const c = or(
      sql`${purchaseOrders.number} LIKE ${p} ESCAPE '\\'`,
      sql`${purchaseOrders.memo} LIKE ${p} ESCAPE '\\'`,
      sql`EXISTS (SELECT 1 FROM ${purchaseOrderLines} l JOIN ${items} i ON i.id = l.item_id WHERE l.purchase_order_id = ${purchaseOrders.id} AND (i.name LIKE ${p} ESCAPE '\\' OR i.code LIKE ${p} ESCAPE '\\'))`,
    );
    if (c) conds.push(c);
  }
  return conds.length > 0 ? and(...conds) : undefined;
}

function toRecord(
  r: {
    readonly supplierHonorific: string;
    readonly supplierPostalCode: string | null;
    readonly supplierAddress: string | null;
    readonly supplierPhone: string | null;
    readonly supplierFax: string | null;
    readonly destinationPostalCode: string | null;
    readonly destinationPlace: string | null;
    readonly destinationPhone: string | null;
  } & Omit<PurchaseOrderRecord, "supplier" | "destination">,
): PurchaseOrderRecord {
  const {
    supplierHonorific,
    supplierPostalCode,
    supplierAddress,
    supplierPhone,
    supplierFax,
    destinationPostalCode,
    destinationPlace,
    destinationPhone,
    ...rest
  } = r;
  return {
    ...rest,
    supplier: {
      honorific: supplierHonorific,
      postalCode: supplierPostalCode,
      address: supplierAddress,
      phone: supplierPhone,
      fax: supplierFax,
    },
    destination: {
      postalCode: destinationPostalCode,
      address: destinationPlace,
      phone: destinationPhone,
    },
  };
}

export function purchaseOrderStore(db: Db): PurchaseOrderStore {
  const base = () =>
    db
      .select(recordColumns)
      .from(purchaseOrders)
      .leftJoin(partners, eq(partners.id, purchaseOrders.supplierId))
      .leftJoin(locations, eq(locations.id, purchaseOrders.destinationLocationId))
      .leftJoin(customers, eq(customers.id, purchaseOrders.destinationCustomerId))
      .leftJoin(employees, eq(employees.id, purchaseOrders.employeeId));

  function lines(orderId: string): PurchaseOrderLineRecord[] {
    return db
      .select({
        id: purchaseOrderLines.id,
        lineNo: purchaseOrderLines.lineNo,
        itemId: purchaseOrderLines.itemId,
        quantity: purchaseOrderLines.quantity,
        unitPriceCenti: purchaseOrderLines.unitPriceCenti,
        unitsPerPurchaseUnit: purchaseOrderLines.unitsPerPurchaseUnit,
        taxCategory: purchaseOrderLines.taxCategory,
        receivedQuantity: purchaseOrderLines.receivedQuantity,
        closed: purchaseOrderLines.closed,
        memo: purchaseOrderLines.memo,
        itemCode: sql<string>`coalesce(${items.code}, '')`,
        itemName: sql<string>`coalesce(${items.name}, '（不明な商品）')`,
        jan: items.jan,
        purchaseUnitName: sql<string>`coalesce(${items.purchaseUnitName}, '')`,
        salesUnitName: sql<string>`coalesce(${items.salesUnitName}, '')`,
      })
      .from(purchaseOrderLines)
      .leftJoin(items, eq(items.id, purchaseOrderLines.itemId))
      .where(eq(purchaseOrderLines.purchaseOrderId, orderId))
      .orderBy(asc(purchaseOrderLines.lineNo))
      .all();
  }

  function insertLines(
    orderId: string,
    rows: Parameters<PurchaseOrderStore["replaceLines"]>[1],
  ): void {
    const values = rows.map((l) => ({
      id: l.id,
      purchaseOrderId: orderId,
      lineNo: l.lineNo,
      itemId: l.itemId,
      quantity: l.quantity,
      unitPriceCenti: l.unitPriceCenti,
      unitsPerPurchaseUnit: l.unitsPerPurchaseUnit,
      taxCategory: l.taxCategory,
      receivedQuantity: 0,
      closed: false,
      memo: l.memo,
    }));
    for (const batch of insertBatches(values, LINE_COLUMNS)) {
      db.insert(purchaseOrderLines).values(batch).run();
    }
  }

  return {
    get(id): PurchaseOrderDetail | undefined {
      const r = base().where(eq(purchaseOrders.id, id)).get();
      return r ? { ...toRecord(r), lines: lines(id) } : undefined;
    },
    insert(id, number, fields, rows, meta) {
      db.insert(purchaseOrders)
        .values({ id, number, status: "draft", ...fields, ...auditInsert(meta) })
        .run();
      insertLines(id, rows);
    },
    update(id, expectedVersion, patch, meta) {
      const rows = db
        .update(purchaseOrders)
        .set({
          ...patch,
          version: sql`${purchaseOrders.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.version, expectedVersion)))
        .returning({ id: purchaseOrders.id })
        .all();
      return rows.length === 1;
    },
    setStatus(id, status, meta) {
      db.update(purchaseOrders)
        .set({
          status,
          version: sql`${purchaseOrders.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(eq(purchaseOrders.id, id))
        .run();
    },
    replaceLines(orderId, rows) {
      db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, orderId)).run();
      insertLines(orderId, rows);
    },
    saveLineProgress(rows) {
      for (const l of rows) {
        db.update(purchaseOrderLines)
          .set({ receivedQuantity: l.receivedQuantity, closed: l.closed })
          .where(eq(purchaseOrderLines.id, l.id))
          .run();
      }
    },
    list(filter, page, pageSize) {
      const where = conditions(filter);
      const total = db.select({ n: count() }).from(purchaseOrders).where(where).get()?.n ?? 0;
      const rows: PurchaseOrderSummary[] = db
        .select({
          ...recordColumns,
          lineCount: sql<number>`(SELECT count(*) FROM ${purchaseOrderLines} l WHERE l.purchase_order_id = ${purchaseOrders.id})`,
        })
        .from(purchaseOrders)
        .leftJoin(partners, eq(partners.id, purchaseOrders.supplierId))
        .leftJoin(locations, eq(locations.id, purchaseOrders.destinationLocationId))
        .leftJoin(customers, eq(customers.id, purchaseOrders.destinationCustomerId))
        .leftJoin(employees, eq(employees.id, purchaseOrders.employeeId))
        .where(where)
        .orderBy(desc(purchaseOrders.orderedOn), desc(purchaseOrders.number))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all()
        .map((r) => Object.assign(toRecord(r), { lineCount: r.lineCount }));
      return { rows, total, page, pageSize };
    },
    count(filter) {
      return db.select({ n: count() }).from(purchaseOrders).where(conditions(filter)).get()?.n ?? 0;
    },
  };
}
