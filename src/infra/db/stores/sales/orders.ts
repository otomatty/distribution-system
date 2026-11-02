import { and, asc, count, desc, eq, gte, isNotNull, lt, lte, or, sql, type SQL } from "drizzle-orm";

import type { WriteMeta } from "../../../../usecases/ports";
import type {
  SalesChargeFields,
  SalesOrderDetail,
  SalesOrderFilter,
  SalesOrderLineFields,
  SalesOrderListRow,
  SalesOrderRecord,
  SalesOrderStore,
  ShippingOrder,
} from "../../../../usecases/sales/orders.port";
import { auditInsert, likePattern, type Db } from "../../client";
import {
  employees,
  items,
  locations,
  partners,
  salesCharges,
  salesOrderLines,
  salesOrders,
  stockBalances,
} from "../../schema";
import { inList, insertBatches } from "../../sql-helpers";

type OrderRow = typeof salesOrders.$inferSelect;

function toRecord(r: OrderRow): SalesOrderRecord {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    customerId: r.customerId,
    orderedOn: r.orderedOn,
    customerContactName: r.customerContactName,
    makerDirect: r.makerDirect,
    locationId: r.locationId,
    employeeId: r.employeeId,
    deliveryRequestedOn: r.deliveryRequestedOn,
    shipPlannedOn: r.shipPlannedOn,
    splitFromId: r.splitFromId,
    memo: r.memo,
    cancelReason: r.cancelReason,
    version: r.version,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    updatedAt: r.updatedAt,
  };
}

/** 明細・送料の1行あたりの列数（INSERT を分ける単位の計算に使う） */
const LINE_COLUMNS = 9;
const CHARGE_COLUMNS = 7;

/**
 * 発送前で、明細のどれかの商品の引当数が保管場所の現在庫を超えている（出荷可能数が足りない）。
 * 受注の明細の警告「出荷可能数を超えています」と同じ判定（自分の引当を足し戻した出荷可能数 < 数量 ⇔ 引当数 > 現在庫）
 */
const shortageCondition = sql`(${salesOrders.status} = 'received' AND ${salesOrders.locationId} IS NOT NULL AND EXISTS (
  SELECT 1 FROM ${salesOrderLines}
  INNER JOIN ${stockBalances} ON ${stockBalances.itemId} = ${salesOrderLines.itemId}
    AND ${stockBalances.locationId} = ${salesOrders.locationId}
  WHERE ${salesOrderLines.salesOrderId} = ${salesOrders.id}
    AND ${stockBalances.allocated} > ${stockBalances.onHand}
))`;

function listWhere(filter: SalesOrderFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.status) conds.push(eq(salesOrders.status, filter.status));
  if (filter.customerId) conds.push(eq(salesOrders.customerId, filter.customerId));
  if (filter.locationId === "maker") conds.push(eq(salesOrders.makerDirect, true));
  else if (filter.locationId) conds.push(eq(salesOrders.locationId, filter.locationId));
  if (filter.shipFrom) conds.push(gte(salesOrders.shipPlannedOn, filter.shipFrom));
  if (filter.shipTo) conds.push(lte(salesOrders.shipPlannedOn, filter.shipTo));
  if (filter.shortage) conds.push(shortageCondition);
  if (filter.q) {
    const p = likePattern(filter.q);
    const c = or(
      sql`${salesOrders.number} LIKE ${p} ESCAPE '\\'`,
      sql`${partners.name} LIKE ${p} ESCAPE '\\'`,
      sql`${partners.kana} LIKE ${p} ESCAPE '\\'`,
      sql`${salesOrders.customerContactName} LIKE ${p} ESCAPE '\\'`,
      sql`${salesOrders.memo} LIKE ${p} ESCAPE '\\'`,
      sql`EXISTS (SELECT 1 FROM ${salesOrderLines} INNER JOIN ${items} ON ${items.id} = ${salesOrderLines.itemId}
        WHERE ${salesOrderLines.salesOrderId} = ${salesOrders.id}
          AND (${items.name} LIKE ${p} ESCAPE '\\' OR ${items.code} LIKE ${p} ESCAPE '\\'))`,
    );
    if (c) conds.push(c);
  }
  return conds.length > 0 ? and(...conds) : undefined;
}

const listColumns = {
  order: salesOrders,
  customerName: partners.name,
  locationName: locations.name,
  employeeName: employees.name,
  lineCount: sql<number>`(SELECT count(*) FROM ${salesOrderLines} WHERE ${salesOrderLines.salesOrderId} = ${salesOrders.id})`,
  shortage: sql<number>`${shortageCondition}`,
};

const listOrder = [desc(salesOrders.shipPlannedOn), desc(salesOrders.number)];

function toListRow(r: {
  order: OrderRow;
  customerName: string | null;
  locationName: string | null;
  employeeName: string | null;
  lineCount: number;
  shortage: number;
}): SalesOrderListRow {
  return {
    ...toRecord(r.order),
    customerName: r.customerName ?? "",
    locationName: r.locationName,
    employeeName: r.employeeName,
    lineCount: r.lineCount,
    shortage: r.shortage === 1,
  };
}

function lineValues(orderId: string, lines: readonly SalesOrderLineFields[]) {
  return lines.map((l, i) => ({
    id: l.id,
    salesOrderId: orderId,
    lineNo: i + 1,
    itemId: l.itemId,
    quantity: l.quantity,
    unitPriceCenti: l.unitPriceCenti,
    priceOverrideReason: l.priceOverrideReason,
    taxCategory: l.taxCategory,
    memo: l.memo,
  }));
}

function chargeValues(orderId: string, charges: readonly SalesChargeFields[]) {
  return charges.map((c) => ({
    id: c.id,
    salesOrderId: orderId,
    description: c.description,
    quantity: c.quantity,
    unitAmount: c.unitAmount,
    taxCategory: c.taxCategory,
    memo: c.memo,
  }));
}

export function salesOrderStore(db: Db): SalesOrderStore {
  const listBase = () =>
    db
      .select(listColumns)
      .from(salesOrders)
      .leftJoin(partners, eq(partners.id, salesOrders.customerId))
      .leftJoin(locations, eq(locations.id, salesOrders.locationId))
      .leftJoin(employees, eq(employees.id, salesOrders.employeeId));

  /** 発送リスト用に、受注と明細（商品名つき）を読む */
  function shippingOrders(where: SQL | undefined): ShippingOrder[] {
    const orders = db
      .select({
        id: salesOrders.id,
        number: salesOrders.number,
        version: salesOrders.version,
        customerId: salesOrders.customerId,
        customerName: partners.name,
        customerKana: partners.kana,
        customerHonorific: partners.honorific,
        locationId: salesOrders.locationId,
        shipPlannedOn: salesOrders.shipPlannedOn,
        memo: salesOrders.memo,
      })
      .from(salesOrders)
      .innerJoin(partners, eq(partners.id, salesOrders.customerId))
      .where(
        and(
          eq(salesOrders.status, "received"),
          eq(salesOrders.makerDirect, false),
          isNotNull(salesOrders.locationId),
          where,
        ),
      )
      .orderBy(asc(salesOrders.number))
      .all();
    if (orders.length === 0) return [];
    const lines = db
      .select({
        salesOrderId: salesOrderLines.salesOrderId,
        itemId: salesOrderLines.itemId,
        itemCode: items.code,
        itemName: items.name,
        salesUnitName: items.salesUnitName,
        quantity: salesOrderLines.quantity,
        onHand: sql<number>`coalesce(${stockBalances.onHand}, 0)`,
      })
      .from(salesOrderLines)
      .innerJoin(salesOrders, eq(salesOrders.id, salesOrderLines.salesOrderId))
      .innerJoin(items, eq(items.id, salesOrderLines.itemId))
      .leftJoin(
        stockBalances,
        and(
          eq(stockBalances.itemId, salesOrderLines.itemId),
          eq(stockBalances.locationId, salesOrders.locationId),
        ),
      )
      .where(
        inList(
          salesOrderLines.salesOrderId,
          orders.map((o) => o.id),
        ),
      )
      .orderBy(asc(salesOrderLines.salesOrderId), asc(salesOrderLines.lineNo))
      .all();
    const byOrder = new Map<string, ShippingOrder["lines"][number][]>();
    for (const l of lines) {
      const list = byOrder.get(l.salesOrderId) ?? [];
      list.push({
        itemId: l.itemId,
        itemCode: l.itemCode,
        itemName: l.itemName,
        salesUnitName: l.salesUnitName,
        quantity: l.quantity,
        onHand: l.onHand,
      });
      byOrder.set(l.salesOrderId, list);
    }
    return orders.map((o): ShippingOrder =>
      Object.assign(o, { locationId: o.locationId ?? "", lines: byOrder.get(o.id) ?? [] }),
    );
  }

  return {
    get(id): SalesOrderDetail | undefined {
      const r = db
        .select({
          order: salesOrders,
          customerName: partners.name,
          customerHonorific: partners.honorific,
          customerPostalCode: partners.postalCode,
          customerAddress: partners.address,
          locationName: locations.name,
          employeeName: employees.name,
        })
        .from(salesOrders)
        .leftJoin(partners, eq(partners.id, salesOrders.customerId))
        .leftJoin(locations, eq(locations.id, salesOrders.locationId))
        .leftJoin(employees, eq(employees.id, salesOrders.employeeId))
        .where(eq(salesOrders.id, id))
        .get();
      if (!r) return undefined;
      const splitFromNumber = r.order.splitFromId
        ? (db
            .select({ number: salesOrders.number })
            .from(salesOrders)
            .where(eq(salesOrders.id, r.order.splitFromId))
            .get()?.number ?? null)
        : null;
      const lines = db
        .select({
          line: salesOrderLines,
          itemCode: items.code,
          itemName: items.name,
          salesUnitName: items.salesUnitName,
          salesMinLot: items.salesMinLot,
          listPriceCenti: items.salesPriceCenti,
          discontinued: items.discontinued,
        })
        .from(salesOrderLines)
        .innerJoin(items, eq(items.id, salesOrderLines.itemId))
        .where(eq(salesOrderLines.salesOrderId, id))
        .orderBy(asc(salesOrderLines.lineNo))
        .all()
        .map((l) => ({
          id: l.line.id,
          lineNo: l.line.lineNo,
          itemId: l.line.itemId,
          quantity: l.line.quantity,
          unitPriceCenti: l.line.unitPriceCenti,
          priceOverrideReason: l.line.priceOverrideReason,
          taxCategory: l.line.taxCategory,
          memo: l.line.memo,
          itemCode: l.itemCode,
          itemName: l.itemName,
          salesUnitName: l.salesUnitName,
          salesMinLot: l.salesMinLot,
          listPriceCenti: l.listPriceCenti,
          discontinued: l.discontinued,
        }));
      const charges = db
        .select({
          id: salesCharges.id,
          description: salesCharges.description,
          quantity: salesCharges.quantity,
          unitAmount: salesCharges.unitAmount,
          taxCategory: salesCharges.taxCategory,
          memo: salesCharges.memo,
        })
        .from(salesCharges)
        .where(eq(salesCharges.salesOrderId, id))
        .orderBy(asc(salesCharges.id))
        .all();
      const splits = db
        .select({ id: salesOrders.id, number: salesOrders.number, status: salesOrders.status })
        .from(salesOrders)
        .where(eq(salesOrders.splitFromId, id))
        .orderBy(asc(salesOrders.number))
        .all();
      return {
        ...toRecord(r.order),
        customerName: r.customerName ?? "",
        customerHonorific: r.customerHonorific ?? "御中",
        customerPostalCode: r.customerPostalCode,
        customerAddress: r.customerAddress,
        locationName: r.locationName,
        employeeName: r.employeeName,
        splitFromNumber,
        lines,
        charges,
        splits,
      };
    },

    list(filter, page, pageSize) {
      const where = listWhere(filter);
      const total =
        db
          .select({ n: count() })
          .from(salesOrders)
          .leftJoin(partners, eq(partners.id, salesOrders.customerId))
          .where(where)
          .get()?.n ?? 0;
      const rows = listBase()
        .where(where)
        .orderBy(...listOrder)
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows: rows.map(toListRow), total, page, pageSize };
    },

    amountSources(orderIds) {
      if (orderIds.length === 0) return { lines: [], charges: [] };
      const lines = db
        .select({
          salesOrderId: salesOrderLines.salesOrderId,
          unitPriceCenti: salesOrderLines.unitPriceCenti,
          quantity: salesOrderLines.quantity,
          taxCategory: salesOrderLines.taxCategory,
        })
        .from(salesOrderLines)
        .where(inList(salesOrderLines.salesOrderId, orderIds))
        .orderBy(asc(salesOrderLines.salesOrderId), asc(salesOrderLines.lineNo))
        .all();
      const charges = db
        .select({
          salesOrderId: salesCharges.salesOrderId,
          unitAmount: salesCharges.unitAmount,
          quantity: salesCharges.quantity,
          taxCategory: salesCharges.taxCategory,
        })
        .from(salesCharges)
        .where(inList(salesCharges.salesOrderId, orderIds))
        .orderBy(asc(salesCharges.salesOrderId), asc(salesCharges.id))
        .all();
      return { lines, charges };
    },

    insert(order, lines, charges, meta: WriteMeta) {
      db.insert(salesOrders)
        .values({ ...order, cancelReason: null, ...auditInsert(meta) })
        .run();
      for (const batch of insertBatches(lineValues(order.id, lines), LINE_COLUMNS))
        db.insert(salesOrderLines).values(batch).run();
      for (const batch of insertBatches(chargeValues(order.id, charges), CHARGE_COLUMNS))
        db.insert(salesCharges).values(batch).run();
    },

    update(id, expectedVersion, patch, meta) {
      const rows = db
        .update(salesOrders)
        .set({
          ...patch,
          version: sql`${salesOrders.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(salesOrders.id, id), eq(salesOrders.version, expectedVersion)))
        .returning({ id: salesOrders.id })
        .all();
      return rows.length === 1;
    },

    replaceLines(orderId, lines) {
      db.delete(salesOrderLines).where(eq(salesOrderLines.salesOrderId, orderId)).run();
      for (const batch of insertBatches(lineValues(orderId, lines), LINE_COLUMNS))
        db.insert(salesOrderLines).values(batch).run();
    },

    replaceCharges(orderId, charges) {
      db.delete(salesCharges).where(eq(salesCharges.salesOrderId, orderId)).run();
      for (const batch of insertBatches(chargeValues(orderId, charges), CHARGE_COLUMNS))
        db.insert(salesCharges).values(batch).run();
    },

    forShipping(shipPlannedOn, locationId) {
      return shippingOrders(
        and(eq(salesOrders.shipPlannedOn, shipPlannedOn), eq(salesOrders.locationId, locationId)),
      );
    },

    shippedIds(shipPlannedOn, locationId) {
      return db
        .select({ id: salesOrders.id })
        .from(salesOrders)
        .where(
          and(
            eq(salesOrders.status, "shipped"),
            eq(salesOrders.shipPlannedOn, shipPlannedOn),
            eq(salesOrders.locationId, locationId),
          ),
        )
        .orderBy(asc(salesOrders.number))
        .all()
        .map((r) => r.id);
    },

    dashboard(today) {
      const shipPlanned = db
        .select({
          locationId: salesOrders.locationId,
          locationName: locations.name,
          count: count(),
        })
        .from(salesOrders)
        .leftJoin(locations, eq(locations.id, salesOrders.locationId))
        .where(and(eq(salesOrders.status, "received"), eq(salesOrders.shipPlannedOn, today)))
        .groupBy(salesOrders.locationId)
        .orderBy(
          sql`${salesOrders.locationId} IS NULL`,
          asc(locations.displayOrder),
          asc(locations.name),
        )
        .all()
        .map((r) => ({
          locationId: r.locationId,
          locationName: r.locationId === null ? "メーカー直" : (r.locationName ?? ""),
          count: r.count,
        }));
      const shortage =
        db.select({ n: count() }).from(salesOrders).where(shortageCondition).get()?.n ?? 0;
      const overdue =
        db
          .select({ n: count() })
          .from(salesOrders)
          .where(and(eq(salesOrders.status, "received"), lt(salesOrders.shipPlannedOn, today)))
          .get()?.n ?? 0;
      return { shipPlanned, shortage, overdue };
    },
  };
}
