import { and, asc, count, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import type {
  AllocationRecord,
  CustomerPaymentFilter,
  CustomerPaymentRecord,
  CustomerPaymentStore,
} from "../../../../usecases/billing/payments.port";
import { auditInsert, type Db } from "../../client";
import { customerPayments, employees, invoices, partners, paymentAllocations } from "../../schema";
import { insertBatches } from "../../sql-helpers";

/** 消込の1行あたりの列数（INSERT を分ける単位の計算に使う） */
const ALLOCATION_COLUMNS = 12;

/*
 * 相関サブクエリの外側の列は "表"."列" で書く（drizzle は結合のない SELECT では列名だけを出すため、
 * サブクエリの中の同じ名前の列と取り違える）
 */

/** 入金ごとの、有効な消込の入金額の合計 */
const allocatedAmount = sql<number>`(SELECT COALESCE(SUM(a.amount), 0) FROM ${paymentAllocations} a WHERE a.payment_id = "customer_payments"."id" AND a.cancelled = 0)`;
const allocationCount = sql<number>`(SELECT COUNT(*) FROM ${paymentAllocations} a WHERE a.payment_id = "customer_payments"."id" AND a.cancelled = 0)`;

function paymentConditions(filter: CustomerPaymentFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.customerId) conds.push(eq(customerPayments.customerId, filter.customerId));
  if (filter.receivedFrom) conds.push(gte(customerPayments.receivedOn, filter.receivedFrom));
  if (filter.receivedTo) conds.push(lte(customerPayments.receivedOn, filter.receivedTo));
  if (!filter.includeCancelled || filter.unallocatedOnly)
    conds.push(eq(customerPayments.cancelled, false));
  if (filter.unallocatedOnly) conds.push(sql`${allocatedAmount} < ${customerPayments.amount}`);
  return conds.length > 0 ? and(...conds) : undefined;
}

const paymentColumns = {
  id: customerPayments.id,
  customerId: customerPayments.customerId,
  customerName: partners.name,
  receivedOn: customerPayments.receivedOn,
  amount: customerPayments.amount,
  method: customerPayments.method,
  memo: customerPayments.memo,
  cancelled: customerPayments.cancelled,
  version: customerPayments.version,
  createdAt: customerPayments.createdAt,
  createdByName: employees.name,
};

const allocationColumns = {
  id: paymentAllocations.id,
  paymentId: paymentAllocations.paymentId,
  invoiceId: paymentAllocations.invoiceId,
  invoiceNumber: invoices.number,
  invoiceStatus: invoices.status,
  amount: paymentAllocations.amount,
  adjustment: paymentAllocations.adjustment,
  adjustmentKind: paymentAllocations.adjustmentKind,
  cancelled: paymentAllocations.cancelled,
  version: paymentAllocations.version,
  createdAt: paymentAllocations.createdAt,
};

function receivableColumns(today: string) {
  const open = sql`i.customer_id = "partners"."id" AND i.status IN ('unpaid', 'partial')`;
  const overdue = sql`${open} AND i.due_on IS NOT NULL AND i.due_on < ${today}`;
  return {
    customerId: partners.id,
    customerName: partners.name,
    openTotal: sql<number>`(SELECT COALESCE(SUM(i.total), 0) FROM ${invoices} i WHERE ${open})`,
    openAllocated: sql<number>`(SELECT COALESCE(SUM(i.allocated), 0) FROM ${invoices} i WHERE ${open})`,
    overdueTotal: sql<number>`(SELECT COALESCE(SUM(i.total), 0) FROM ${invoices} i WHERE ${overdue})`,
    overdueAllocated: sql<number>`(SELECT COALESCE(SUM(i.allocated), 0) FROM ${invoices} i WHERE ${overdue})`,
    openCount: sql<number>`(SELECT COUNT(*) FROM ${invoices} i WHERE ${open})`,
    overdueCount: sql<number>`(SELECT COUNT(*) FROM ${invoices} i WHERE ${overdue})`,
    nextDueOn: sql<string | null>`(SELECT MIN(i.due_on) FROM ${invoices} i WHERE ${open})`,
    paymentTotal: sql<number>`(SELECT COALESCE(SUM(p.amount), 0) FROM ${customerPayments} p WHERE p.customer_id = "partners"."id" AND p.cancelled = 0)`,
    paymentAllocated: sql<number>`(SELECT COALESCE(SUM(a.amount), 0) FROM ${paymentAllocations} a INNER JOIN ${customerPayments} p ON p.id = a.payment_id WHERE p.customer_id = "partners"."id" AND p.cancelled = 0 AND a.cancelled = 0)`,
  };
}

function bump(meta: { at: string; by: string }) {
  return {
    version: sql`${customerPayments.version} + 1`,
    updatedAt: meta.at,
    updatedBy: meta.by,
  };
}

export function customerPaymentStore(db: Db): CustomerPaymentStore {
  return {
    get(id): CustomerPaymentRecord | undefined {
      return db
        .select(paymentColumns)
        .from(customerPayments)
        .innerJoin(partners, eq(partners.id, customerPayments.customerId))
        .leftJoin(employees, eq(employees.id, customerPayments.createdBy))
        .where(eq(customerPayments.id, id))
        .get();
    },
    list(filter, page, pageSize) {
      const where = paymentConditions(filter);
      const total = db.select({ n: count() }).from(customerPayments).where(where).get()?.n ?? 0;
      const rows = db
        .select({ ...paymentColumns, allocatedAmount, allocationCount })
        .from(customerPayments)
        .innerJoin(partners, eq(partners.id, customerPayments.customerId))
        .leftJoin(employees, eq(employees.id, customerPayments.createdBy))
        .where(where)
        .orderBy(desc(customerPayments.receivedOn), desc(customerPayments.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows, total, page, pageSize };
    },
    insert(record, meta) {
      db.insert(customerPayments)
        .values({ ...record, cancelled: false, ...auditInsert(meta) })
        .run();
    },
    touch(id, expectedVersion, meta) {
      const rows = db
        .update(customerPayments)
        .set(bump(meta))
        .where(and(eq(customerPayments.id, id), eq(customerPayments.version, expectedVersion)))
        .returning({ id: customerPayments.id })
        .all();
      return rows.length === 1;
    },
    cancel(id, expectedVersion, meta) {
      const rows = db
        .update(customerPayments)
        .set({ cancelled: true, ...bump(meta) })
        .where(
          and(
            eq(customerPayments.id, id),
            eq(customerPayments.version, expectedVersion),
            eq(customerPayments.cancelled, false),
          ),
        )
        .returning({ id: customerPayments.id })
        .all();
      return rows.length === 1;
    },
    allocations(paymentId): AllocationRecord[] {
      return db
        .select(allocationColumns)
        .from(paymentAllocations)
        .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
        .where(eq(paymentAllocations.paymentId, paymentId))
        .orderBy(desc(paymentAllocations.id))
        .all();
    },
    getAllocation(id) {
      return db
        .select(allocationColumns)
        .from(paymentAllocations)
        .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
        .where(eq(paymentAllocations.id, id))
        .get();
    },
    insertAllocations(rows, meta) {
      const values = rows.map((r) => ({ ...r, cancelled: false, ...auditInsert(meta) }));
      for (const batch of insertBatches(values, ALLOCATION_COLUMNS))
        db.insert(paymentAllocations).values(batch).run();
    },
    cancelAllocation(id, expectedVersion, meta) {
      const rows = db
        .update(paymentAllocations)
        .set({
          cancelled: true,
          version: sql`${paymentAllocations.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(
          and(
            eq(paymentAllocations.id, id),
            eq(paymentAllocations.version, expectedVersion),
            eq(paymentAllocations.cancelled, false),
          ),
        )
        .returning({ id: paymentAllocations.id })
        .all();
      return rows.length === 1;
    },
    receivables(filter, page, pageSize) {
      const columns = receivableColumns(filter.today);
      const conds: SQL[] = [
        eq(partners.isCustomer, true),
        sql`(${columns.openCount} > 0 OR ${columns.paymentTotal} > ${columns.paymentAllocated})`,
      ];
      if (filter.customerId) conds.push(eq(partners.id, filter.customerId));
      const where = and(...conds);
      const total = db.select({ n: count() }).from(partners).where(where).get()?.n ?? 0;
      const rows = db
        .select(columns)
        .from(partners)
        .where(where)
        .orderBy(asc(partners.kana), asc(partners.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows, total, page, pageSize };
    },
  };
}
