import { and, asc, count, desc, eq, gte, lte, max, sql, sum, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type {
  DisposalFilter,
  DisposalRateSource,
  DisposalStore,
} from "../../../../usecases/billing/disposals.port";
import { auditInsert, type Db } from "../../client";
import {
  disposalLines,
  disposals,
  employees,
  items,
  partners,
  salesOrderLines,
  salesOrders,
  shipments,
} from "../../schema";
import { inList, insertBatches } from "../../sql-helpers";

const cancelledBy = alias(employees, "cancelled_by_employee");

function conditions(filter: DisposalFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.customerId) conds.push(eq(disposals.customerId, filter.customerId));
  if (filter.from) conds.push(gte(disposals.disposedOn, filter.from));
  if (filter.to) conds.push(lte(disposals.disposedOn, filter.to));
  if (filter.cancelled) conds.push(eq(disposals.cancelled, filter.cancelled === "only"));
  return conds.length > 0 ? and(...conds) : undefined;
}

function pairKey(customerId: string, itemId: string): string {
  return `${customerId}\u0000${itemId}`;
}

export function disposalStore(db: Db): DisposalStore {
  return {
    get(id) {
      const head = db
        .select({
          d: disposals,
          customerName: partners.name,
          createdByName: employees.name,
          cancelledByName: cancelledBy.name,
        })
        .from(disposals)
        .innerJoin(partners, eq(partners.id, disposals.customerId))
        .leftJoin(employees, eq(employees.id, disposals.createdBy))
        .leftJoin(cancelledBy, eq(cancelledBy.id, disposals.cancelledBy))
        .where(eq(disposals.id, id))
        .get();
      if (!head) return undefined;
      const lines = db
        .select({
          id: disposalLines.id,
          itemId: disposalLines.itemId,
          itemCode: items.code,
          itemName: items.name,
          unitName: items.salesUnitName,
          quantity: disposalLines.quantity,
          reason: disposalLines.reason,
        })
        .from(disposalLines)
        .innerJoin(items, eq(items.id, disposalLines.itemId))
        .where(eq(disposalLines.disposalId, id))
        .orderBy(asc(disposalLines.id))
        .all();
      return {
        id: head.d.id,
        number: head.d.number,
        customerId: head.d.customerId,
        customerName: head.customerName,
        disposedOn: head.d.disposedOn,
        contactName: head.d.contactName,
        memo: head.d.memo,
        cancelled: head.d.cancelled,
        cancelReason: head.d.cancelReason,
        cancelledAt: head.d.cancelledAt,
        cancelledByName: head.cancelledByName,
        version: head.d.version,
        createdAt: head.d.createdAt,
        createdByName: head.createdByName,
        lines,
      };
    },
    list(filter, page, pageSize) {
      const where = conditions(filter);
      const total = db.select({ n: count() }).from(disposals).where(where).get()?.n ?? 0;
      const rows = db
        .select({
          id: disposals.id,
          number: disposals.number,
          customerId: disposals.customerId,
          customerName: partners.name,
          disposedOn: disposals.disposedOn,
          contactName: disposals.contactName,
          cancelled: disposals.cancelled,
          cancelReason: disposals.cancelReason,
          createdAt: disposals.createdAt,
          lineCount: sql<number>`(SELECT COUNT(*) FROM ${disposalLines} l WHERE l.disposal_id = "disposals"."id")`,
          totalQuantity: sql<number>`(SELECT COALESCE(SUM(l.quantity), 0) FROM ${disposalLines} l WHERE l.disposal_id = "disposals"."id")`,
        })
        .from(disposals)
        .innerJoin(partners, eq(partners.id, disposals.customerId))
        .where(where)
        .orderBy(desc(disposals.disposedOn), desc(disposals.number))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows, total, page, pageSize };
    },
    insert(record, lines, meta) {
      db.insert(disposals)
        .values({ ...record, ...auditInsert(meta) })
        .run();
      const values = lines.map((l) => ({ disposalId: record.id, ...l }));
      for (const batch of insertBatches(values, 5)) db.insert(disposalLines).values(batch).run();
    },
    markCancelled(id, expectedVersion, reason, meta) {
      const rows = db
        .update(disposals)
        .set({
          cancelled: true,
          cancelReason: reason,
          cancelledAt: meta.at,
          cancelledBy: meta.by,
          version: sql`${disposals.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(
          and(
            eq(disposals.id, id),
            eq(disposals.version, expectedVersion),
            eq(disposals.cancelled, false),
          ),
        )
        .returning({ id: disposals.id })
        .all();
      return rows.length === 1;
    },
    shippedItems(customerId, limit) {
      const last = max(shipments.shippedOn);
      return db
        .select({
          itemId: salesOrderLines.itemId,
          itemCode: items.code,
          itemName: items.name,
          unitName: items.salesUnitName,
          lastShippedOn: sql<string>`${last}`,
        })
        .from(shipments)
        .innerJoin(salesOrders, eq(salesOrders.id, shipments.salesOrderId))
        .innerJoin(salesOrderLines, eq(salesOrderLines.salesOrderId, salesOrders.id))
        .innerJoin(items, eq(items.id, salesOrderLines.itemId))
        .where(and(eq(salesOrders.customerId, customerId), eq(shipments.cancelled, false)))
        .groupBy(salesOrderLines.itemId)
        .orderBy(desc(last), asc(items.code))
        .limit(limit)
        .all();
    },
    rateSources(filter): DisposalRateSource[] {
      // 取り消した廃棄伝票は集計に含めない
      const disposedConds: SQL[] = [
        eq(disposals.cancelled, false),
        gte(disposals.disposedOn, filter.from),
        lte(disposals.disposedOn, filter.to),
      ];
      if (filter.customerId) disposedConds.push(eq(disposals.customerId, filter.customerId));
      if (filter.itemId) disposedConds.push(eq(disposalLines.itemId, filter.itemId));
      const disposed = db
        .select({
          customerId: disposals.customerId,
          itemId: disposalLines.itemId,
          quantity: sum(disposalLines.quantity).mapWith(Number),
        })
        .from(disposalLines)
        .innerJoin(disposals, eq(disposals.id, disposalLines.disposalId))
        .where(and(...disposedConds))
        .groupBy(disposals.customerId, disposalLines.itemId)
        .all();
      const shippedConds: SQL[] = [
        eq(shipments.cancelled, false),
        gte(shipments.shippedOn, filter.from),
        lte(shipments.shippedOn, filter.to),
      ];
      if (filter.customerId) shippedConds.push(eq(salesOrders.customerId, filter.customerId));
      if (filter.itemId) shippedConds.push(eq(salesOrderLines.itemId, filter.itemId));
      const shipped = db
        .select({
          customerId: salesOrders.customerId,
          itemId: salesOrderLines.itemId,
          quantity: sum(salesOrderLines.quantity).mapWith(Number),
        })
        .from(shipments)
        .innerJoin(salesOrders, eq(salesOrders.id, shipments.salesOrderId))
        .innerJoin(salesOrderLines, eq(salesOrderLines.salesOrderId, salesOrders.id))
        .where(and(...shippedConds))
        .groupBy(salesOrders.customerId, salesOrderLines.itemId)
        .all();
      const pairs = new Map<
        string,
        { customerId: string; itemId: string; disposed: number; shipped: number }
      >();
      for (const d of disposed)
        pairs.set(pairKey(d.customerId, d.itemId), { ...d, disposed: d.quantity, shipped: 0 });
      for (const s of shipped) {
        const key = pairKey(s.customerId, s.itemId);
        const p = pairs.get(key);
        if (p) p.shipped = s.quantity;
        else
          pairs.set(key, {
            customerId: s.customerId,
            itemId: s.itemId,
            disposed: 0,
            shipped: s.quantity,
          });
      }
      if (pairs.size === 0) return [];
      const list = [...pairs.values()];
      const customers = new Map(
        db
          .select({ id: partners.id, name: partners.name, kana: partners.kana })
          .from(partners)
          .where(inList(partners.id, [...new Set(list.map((p) => p.customerId))]))
          .all()
          .map((p) => [p.id, p]),
      );
      const itemRows = new Map(
        db
          .select({
            id: items.id,
            code: items.code,
            name: items.name,
            unitName: items.salesUnitName,
          })
          .from(items)
          .where(inList(items.id, [...new Set(list.map((p) => p.itemId))]))
          .all()
          .map((i) => [i.id, i]),
      );
      return list
        .flatMap((p): DisposalRateSource[] => {
          const c = customers.get(p.customerId);
          const i = itemRows.get(p.itemId);
          if (!c || !i) return [];
          return [
            {
              customerId: p.customerId,
              customerName: c.name,
              customerKana: c.kana,
              itemId: p.itemId,
              itemCode: i.code,
              itemName: i.name,
              unitName: i.unitName,
              disposed: p.disposed,
              shipped: p.shipped,
            },
          ];
        })
        .toSorted(
          (a, b) =>
            a.customerKana.localeCompare(b.customerKana, "ja") ||
            a.customerId.localeCompare(b.customerId) ||
            a.itemCode.localeCompare(b.itemCode),
        );
    },
  };
}
