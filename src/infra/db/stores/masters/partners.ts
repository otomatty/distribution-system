import { and, asc, count, eq, or, sql, type SQL } from "drizzle-orm";

import type {
  PartnerFields,
  PartnerFilter,
  PartnerOption,
  PartnerRecord,
  PartnerStore,
  PartnerTerms,
} from "../../../../usecases/masters/partners.port";
import type { WriteMeta } from "../../../../usecases/ports";
import type { Page } from "../../../../usecases/schemas";
import { auditInsert, likePattern, type Db } from "../../client";
import {
  customerPayments,
  disposals,
  invoices,
  items,
  partners,
  purchaseOrders,
  salesOrders,
  supplierInvoices,
} from "../../schema";

type Row = typeof partners.$inferSelect;

function toRecord(r: Row): PartnerRecord {
  return {
    id: r.id,
    name: r.name,
    kana: r.kana,
    honorific: r.honorific,
    isSupplier: r.isSupplier,
    isCustomer: r.isCustomer,
    contactName: r.contactName,
    postalCode: r.postalCode,
    address: r.address,
    phone: r.phone,
    mobile: r.mobile,
    fax: r.fax,
    email: r.email,
    lineId: r.lineId,
    mainContact: r.mainContact,
    registrationNumber: r.registrationNumber,
    closingDay: r.closingDay,
    paymentMonthOffset: r.paymentMonthOffset,
    paymentDay: r.paymentDay,
    deliveryDays: r.deliveryDays,
    defaultSendMethod: r.defaultSendMethod,
    orderMethodNote: r.orderMethodNote,
    receiveMethodNote: r.receiveMethodNote,
    mailOrderAllowed: r.mailOrderAllowed,
    placeName: r.placeName,
    memo: r.memo,
    archived: r.archived,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function partnerStore(db: Db): PartnerStore {
  return {
    get(id) {
      const r = db.select().from(partners).where(eq(partners.id, id)).get();
      return r ? toRecord(r) : undefined;
    },
    list(filter: PartnerFilter, page: number, pageSize: number): Page<PartnerRecord> {
      const conds: SQL[] = [];
      if (filter.q) {
        const p = likePattern(filter.q);
        const c = or(
          sql`${partners.name} LIKE ${p} ESCAPE '\\'`,
          sql`${partners.kana} LIKE ${p} ESCAPE '\\'`,
          sql`${partners.phone} LIKE ${p} ESCAPE '\\'`,
        );
        if (c) conds.push(c);
      }
      if (filter.role === "supplier") conds.push(eq(partners.isSupplier, true));
      if (filter.role === "customer") conds.push(eq(partners.isCustomer, true));
      if (!filter.includeArchived) conds.push(eq(partners.archived, false));
      const where = conds.length > 0 ? and(...conds) : undefined;
      const total = db.select({ n: count() }).from(partners).where(where).get()?.n ?? 0;
      const rows = db
        .select()
        .from(partners)
        .where(where)
        .orderBy(asc(partners.kana), asc(partners.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows: rows.map(toRecord), total, page, pageSize };
    },
    options(role): PartnerOption[] {
      return db
        .select({ id: partners.id, name: partners.name, kana: partners.kana })
        .from(partners)
        .where(
          and(
            eq(partners.archived, false),
            role === "supplier" ? eq(partners.isSupplier, true) : eq(partners.isCustomer, true),
          ),
        )
        .orderBy(asc(partners.kana))
        .all();
    },
    insert(id, fields: PartnerFields & PartnerTerms, meta: WriteMeta) {
      db.insert(partners)
        .values({ id, ...fields, archived: false, ...auditInsert(meta) })
        .run();
    },
    update(id, expectedVersion, patch, meta) {
      const rows = db
        .update(partners)
        .set({
          ...patch,
          version: sql`${partners.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(partners.id, id), eq(partners.version, expectedVersion)))
        .returning({ id: partners.id })
        .all();
      return rows.length === 1;
    },
    isReferenced(id) {
      const checks = [
        db.select({ id: items.id }).from(items).where(eq(items.supplierId, id)).limit(1).get(),
        db
          .select({ id: purchaseOrders.id })
          .from(purchaseOrders)
          .where(
            or(eq(purchaseOrders.supplierId, id), eq(purchaseOrders.destinationCustomerId, id)),
          )
          .limit(1)
          .get(),
        db
          .select({ id: salesOrders.id })
          .from(salesOrders)
          .where(eq(salesOrders.customerId, id))
          .limit(1)
          .get(),
        db
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.customerId, id))
          .limit(1)
          .get(),
        db
          .select({ id: supplierInvoices.id })
          .from(supplierInvoices)
          .where(eq(supplierInvoices.supplierId, id))
          .limit(1)
          .get(),
        db
          .select({ id: customerPayments.id })
          .from(customerPayments)
          .where(eq(customerPayments.customerId, id))
          .limit(1)
          .get(),
        db
          .select({ id: disposals.id })
          .from(disposals)
          .where(eq(disposals.customerId, id))
          .limit(1)
          .get(),
      ];
      return checks.some((c) => c !== undefined);
    },
    delete(id, expectedVersion) {
      const rows = db
        .delete(partners)
        .where(and(eq(partners.id, id), eq(partners.version, expectedVersion)))
        .returning({ id: partners.id })
        .all();
      return rows.length === 1;
    },
  };
}
