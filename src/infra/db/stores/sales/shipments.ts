import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";

import type {
  DeliveryNoteRef,
  ShipmentHistoryRow,
  ShipmentRecord,
  ShipmentStore,
  UnbilledShipment,
} from "../../../../usecases/sales/shipments.port";
import { auditInsert, type Db } from "../../client";
import {
  documents,
  employees,
  items,
  partners,
  salesCharges,
  salesOrderLines,
  salesOrders,
  shipments,
} from "../../schema";
import { inList } from "../../sql-helpers";

type Row = typeof shipments.$inferSelect;

function toRecord(r: Row): ShipmentRecord {
  return {
    id: r.id,
    salesOrderId: r.salesOrderId,
    deliveryNoteNumber: r.deliveryNoteNumber,
    shippedOn: r.shippedOn,
    invoiceId: r.invoiceId,
    cancelled: r.cancelled,
    cancelReason: r.cancelReason,
    version: r.version,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    updatedAt: r.updatedAt,
  };
}

export function shipmentStore(db: Db): ShipmentStore {
  /** 発送ごとの最新の納品書（取り消したものも含む）。documents は共通の仕組みの索引 */
  function latestDeliveryNotes(shipmentIds: readonly string[]): Map<string, DeliveryNoteRef> {
    const out = new Map<string, DeliveryNoteRef>();
    if (shipmentIds.length === 0) return out;
    const rows = db
      .select({
        id: documents.id,
        entityId: documents.entityId,
        status: documents.status,
        cancelled: documents.cancelled,
      })
      .from(documents)
      .where(
        and(eq(documents.documentType, "delivery_note"), inList(documents.entityId, shipmentIds)),
      )
      .orderBy(desc(documents.id))
      .all();
    for (const r of rows) {
      if (out.has(r.entityId)) continue;
      out.set(r.entityId, {
        shipmentId: r.entityId,
        documentId: r.id,
        status: r.status,
        cancelled: r.cancelled,
      });
    }
    return out;
  }

  return {
    get(id) {
      const r = db.select().from(shipments).where(eq(shipments.id, id)).get();
      return r ? toRecord(r) : undefined;
    },
    activeFor(salesOrderId) {
      const r = db
        .select()
        .from(shipments)
        .where(and(eq(shipments.salesOrderId, salesOrderId), eq(shipments.cancelled, false)))
        .get();
      return r ? toRecord(r) : undefined;
    },
    historyFor(salesOrderId) {
      const rows = db
        .select({ shipment: shipments, createdByName: employees.name })
        .from(shipments)
        .leftJoin(employees, eq(employees.id, shipments.createdBy))
        .where(eq(shipments.salesOrderId, salesOrderId))
        .orderBy(desc(shipments.id))
        .all();
      const notes = latestDeliveryNotes(rows.map((r) => r.shipment.id));
      return rows.map((r): ShipmentHistoryRow =>
        Object.assign(toRecord(r.shipment), {
          createdByName: r.createdByName,
          deliveryNote: notes.get(r.shipment.id) ?? null,
        }),
      );
    },
    insert(record, meta) {
      db.insert(shipments)
        .values({ ...record, ...auditInsert(meta) })
        .run();
    },
    cancel(id, expectedVersion, reason, meta) {
      const rows = db
        .update(shipments)
        .set({
          cancelled: true,
          cancelReason: reason,
          version: sql`${shipments.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(
          and(
            eq(shipments.id, id),
            eq(shipments.version, expectedVersion),
            eq(shipments.cancelled, false),
          ),
        )
        .returning({ id: shipments.id })
        .all();
      return rows.length === 1;
    },
    deliveryNoteIds(shipmentIds) {
      const notes = latestDeliveryNotes(shipmentIds);
      return shipmentIds.flatMap((id) => {
        const n = notes.get(id);
        return n && !n.cancelled ? [n.documentId] : [];
      });
    },
    activeForOrders(salesOrderIds) {
      if (salesOrderIds.length === 0) return [];
      return db
        .select()
        .from(shipments)
        .where(and(inList(shipments.salesOrderId, salesOrderIds), eq(shipments.cancelled, false)))
        .orderBy(asc(shipments.id))
        .all()
        .map(toRecord);
    },
    unbilled(filter, limit): UnbilledShipment[] {
      const conds: SQL[] = [eq(shipments.cancelled, false), isNull(shipments.invoiceId)];
      if (filter.customerId) conds.push(eq(salesOrders.customerId, filter.customerId));
      if (filter.shippedFrom) conds.push(gte(shipments.shippedOn, filter.shippedFrom));
      if (filter.shippedTo) conds.push(lte(shipments.shippedOn, filter.shippedTo));
      const heads = db
        .select({
          shipmentId: shipments.id,
          shipmentVersion: shipments.version,
          salesOrderId: shipments.salesOrderId,
          salesOrderNumber: salesOrders.number,
          customerId: salesOrders.customerId,
          customerName: partners.name,
          shippedOn: shipments.shippedOn,
          deliveryNoteNumber: shipments.deliveryNoteNumber,
        })
        .from(shipments)
        .innerJoin(salesOrders, eq(salesOrders.id, shipments.salesOrderId))
        .innerJoin(partners, eq(partners.id, salesOrders.customerId))
        .where(and(...conds))
        .orderBy(asc(shipments.shippedOn), asc(shipments.deliveryNoteNumber))
        .limit(limit)
        .all();
      if (heads.length === 0) return [];
      const orderIds = heads.map((h) => h.salesOrderId);
      const lines = db
        .select({
          salesOrderId: salesOrderLines.salesOrderId,
          salesOrderLineId: salesOrderLines.id,
          itemId: salesOrderLines.itemId,
          itemCode: items.code,
          itemName: items.name,
          salesUnitName: items.salesUnitName,
          quantity: salesOrderLines.quantity,
          unitPriceCenti: salesOrderLines.unitPriceCenti,
          taxCategory: salesOrderLines.taxCategory,
        })
        .from(salesOrderLines)
        .innerJoin(items, eq(items.id, salesOrderLines.itemId))
        .where(inList(salesOrderLines.salesOrderId, orderIds))
        .orderBy(asc(salesOrderLines.salesOrderId), asc(salesOrderLines.lineNo))
        .all();
      const charges = db
        .select({
          salesOrderId: salesCharges.salesOrderId,
          salesChargeId: salesCharges.id,
          description: salesCharges.description,
          quantity: salesCharges.quantity,
          unitAmount: salesCharges.unitAmount,
          taxCategory: salesCharges.taxCategory,
        })
        .from(salesCharges)
        .where(inList(salesCharges.salesOrderId, orderIds))
        .orderBy(asc(salesCharges.salesOrderId), asc(salesCharges.id))
        .all();
      return heads.map((h): UnbilledShipment =>
        Object.assign(h, {
          lines: lines.filter((l) => l.salesOrderId === h.salesOrderId),
          charges: charges.filter((c) => c.salesOrderId === h.salesOrderId),
        }),
      );
    },
  };
}
