import { and, asc, count, desc, eq, gte, isNotNull, lte, sql, type SQL } from "drizzle-orm";

import type {
  AllocationRecord,
  CustomerPaymentFilter,
  CustomerPaymentRecord,
  CustomerPaymentStore,
  RefundRecord,
} from "../../../../usecases/billing/payments.port";
import { auditInsert, type Db } from "../../client";
import {
  customerPayments,
  customerRefunds,
  employees,
  invoices,
  partners,
  paymentAllocations,
  salesReturns,
} from "../../schema";
import { inList, insertBatches } from "../../sql-helpers";

/** 消込の1行あたりの列数（INSERT を分ける単位の計算に使う） */
const ALLOCATION_COLUMNS = 12;

/*
 * 相関サブクエリの外側の列は "表"."列" で書く（drizzle は結合のない SELECT では列名だけを出すため、
 * サブクエリの中の同じ名前の列と取り違える）
 */

/** 入金ごとの、有効な消込の入金額の合計 */
const allocatedAmount = sql<number>`(SELECT COALESCE(SUM(a.amount), 0) FROM ${paymentAllocations} a WHERE a.payment_id = "customer_payments"."id" AND a.cancelled = 0)`;
const allocationCount = sql<number>`(SELECT COUNT(*) FROM ${paymentAllocations} a WHERE a.payment_id = "customer_payments"."id" AND a.cancelled = 0)`;
/** 入金（返還請求書の返還額）ごとの、有効な返金の合計 */
const refundedAmount = sql<number>`(SELECT COALESCE(SUM(r.amount), 0) FROM ${customerRefunds} r WHERE r.payment_id = "customer_payments"."id" AND r.cancelled = 0)`;

function paymentConditions(filter: CustomerPaymentFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.customerId) conds.push(eq(customerPayments.customerId, filter.customerId));
  if (filter.receivedFrom) conds.push(gte(customerPayments.receivedOn, filter.receivedFrom));
  if (filter.receivedTo) conds.push(lte(customerPayments.receivedOn, filter.receivedTo));
  if (!filter.includeCancelled || filter.unallocatedOnly)
    conds.push(eq(customerPayments.cancelled, false));
  if (filter.unallocatedOnly)
    conds.push(sql`${allocatedAmount} + ${refundedAmount} < ${customerPayments.amount}`);
  if (filter.creditOnly) conds.push(isNotNull(customerPayments.salesReturnId));
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
  salesReturnId: customerPayments.salesReturnId,
  salesReturnNumber: salesReturns.number,
  version: customerPayments.version,
  createdAt: customerPayments.createdAt,
  createdByName: employees.name,
};

const refundColumns = {
  id: customerRefunds.id,
  paymentId: customerRefunds.paymentId,
  customerId: customerRefunds.customerId,
  refundedOn: customerRefunds.refundedOn,
  amount: customerRefunds.amount,
  memo: customerRefunds.memo,
  cancelled: customerRefunds.cancelled,
  cancelReason: customerRefunds.cancelReason,
  version: customerRefunds.version,
  createdAt: customerRefunds.createdAt,
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

/**
 * 売掛残高の元になる集計。未入金・一部入金の請求書、入金、消込をそれぞれ1回ずつ販売先ごとに集計して結びつける
 * （販売先ごとの副問い合わせでは、販売先の数 × 請求書・入金を読み、本番の5倍の量で1秒を超える。docs/performance.md）
 */
function receivableSources(
  db: Db,
  filter: { readonly customerId?: string | undefined; readonly today: string },
) {
  const overdue = sql`${invoices.dueOn} IS NOT NULL AND ${invoices.dueOn} < ${filter.today}`;
  const openConds: SQL[] = [inList(invoices.status, ["unpaid", "partial"])];
  const paidConds: SQL[] = [eq(customerPayments.cancelled, false)];
  if (filter.customerId) {
    openConds.push(eq(invoices.customerId, filter.customerId));
    paidConds.push(eq(customerPayments.customerId, filter.customerId));
  }
  const open = db
    .select({
      customerId: sql<string>`${invoices.customerId}`.as("open_customer_id"),
      total: sql<number>`sum(${invoices.total})`.as("open_total"),
      allocated: sql<number>`sum(${invoices.allocated})`.as("open_allocated"),
      overdueTotal: sql<number>`sum(CASE WHEN ${overdue} THEN ${invoices.total} ELSE 0 END)`.as(
        "overdue_total",
      ),
      overdueAllocated:
        sql<number>`sum(CASE WHEN ${overdue} THEN ${invoices.allocated} ELSE 0 END)`.as(
          "overdue_allocated",
        ),
      count: sql<number>`count(*)`.as("open_count"),
      overdueCount: sql<number>`sum(CASE WHEN ${overdue} THEN 1 ELSE 0 END)`.as("overdue_count"),
      nextDueOn: sql<string | null>`min(${invoices.dueOn})`.as("next_due_on"),
    })
    .from(invoices)
    .where(and(...openConds))
    .groupBy(invoices.customerId)
    .as("open_invoices");
  const paid = db
    .select({
      customerId: sql<string>`${customerPayments.customerId}`.as("paid_customer_id"),
      amount: sql<number>`sum(${customerPayments.amount})`.as("paid_amount"),
    })
    .from(customerPayments)
    .where(and(...paidConds))
    .groupBy(customerPayments.customerId)
    .as("paid");
  const used = db
    .select({
      customerId: sql<string>`${customerPayments.customerId}`.as("used_customer_id"),
      amount: sql<number>`sum(${paymentAllocations.amount})`.as("used_amount"),
    })
    .from(paymentAllocations)
    .innerJoin(customerPayments, eq(customerPayments.id, paymentAllocations.paymentId))
    .where(and(...paidConds, eq(paymentAllocations.cancelled, false)))
    .groupBy(customerPayments.customerId)
    .as("used");
  // 返還請求書の返還額のうち返金した額。返金は少ないので、返金の側から読んで入金（取り消していないもの）を確かめる
  // （入金と結びつけると、すべての入金を読んでから返金を探す計画になる）
  const refundConds: SQL[] = [
    eq(customerRefunds.cancelled, false),
    sql`EXISTS (SELECT 1 FROM ${customerPayments} p WHERE p.id = "customer_refunds"."payment_id" AND p.cancelled = 0)`,
  ];
  if (filter.customerId) refundConds.push(eq(customerRefunds.customerId, filter.customerId));
  const refunded = db
    .select({
      customerId: sql<string>`${customerRefunds.customerId}`.as("refunded_customer_id"),
      amount: sql<number>`sum(${customerRefunds.amount})`.as("refunded_amount"),
    })
    .from(customerRefunds)
    .where(and(...refundConds))
    .groupBy(customerRefunds.customerId)
    .as("refunded");
  return { open, paid, used, refunded };
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
        .leftJoin(salesReturns, eq(salesReturns.id, customerPayments.salesReturnId))
        .leftJoin(employees, eq(employees.id, customerPayments.createdBy))
        .where(eq(customerPayments.id, id))
        .get();
    },
    activeCreditFor(salesReturnId) {
      return db
        .select(paymentColumns)
        .from(customerPayments)
        .innerJoin(partners, eq(partners.id, customerPayments.customerId))
        .leftJoin(salesReturns, eq(salesReturns.id, customerPayments.salesReturnId))
        .leftJoin(employees, eq(employees.id, customerPayments.createdBy))
        .where(
          and(
            eq(customerPayments.salesReturnId, salesReturnId),
            eq(customerPayments.cancelled, false),
          ),
        )
        .orderBy(desc(customerPayments.id))
        .get();
    },
    list(filter, page, pageSize) {
      const where = paymentConditions(filter);
      const total = db.select({ n: count() }).from(customerPayments).where(where).get()?.n ?? 0;
      const rows = db
        .select({ ...paymentColumns, allocatedAmount, allocationCount, refundedAmount })
        .from(customerPayments)
        .innerJoin(partners, eq(partners.id, customerPayments.customerId))
        .leftJoin(salesReturns, eq(salesReturns.id, customerPayments.salesReturnId))
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
    refunds(paymentId): RefundRecord[] {
      return db
        .select(refundColumns)
        .from(customerRefunds)
        .leftJoin(employees, eq(employees.id, customerRefunds.createdBy))
        .where(eq(customerRefunds.paymentId, paymentId))
        .orderBy(desc(customerRefunds.id))
        .all();
    },
    getRefund(id) {
      return db
        .select(refundColumns)
        .from(customerRefunds)
        .leftJoin(employees, eq(employees.id, customerRefunds.createdBy))
        .where(eq(customerRefunds.id, id))
        .get();
    },
    insertRefund(record, meta) {
      db.insert(customerRefunds)
        .values({ ...record, cancelled: false, cancelReason: null, ...auditInsert(meta) })
        .run();
    },
    cancelRefund(id, expectedVersion, reason, meta) {
      const rows = db
        .update(customerRefunds)
        .set({
          cancelled: true,
          cancelReason: reason,
          version: sql`${customerRefunds.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(
          and(
            eq(customerRefunds.id, id),
            eq(customerRefunds.version, expectedVersion),
            eq(customerRefunds.cancelled, false),
          ),
        )
        .returning({ id: customerRefunds.id })
        .all();
      return rows.length === 1;
    },
    receivables(filter, page, pageSize) {
      const { open, paid, used, refunded } = receivableSources(db, filter);
      const paymentTotal = sql<number>`coalesce(${paid.amount}, 0)`;
      const paymentAllocated = sql<number>`coalesce(${used.amount}, 0)`;
      const paymentRefunded = sql<number>`coalesce(${refunded.amount}, 0)`;
      const conds: SQL[] = [
        eq(partners.isCustomer, true),
        sql`(coalesce(${open.count}, 0) > 0 OR ${paymentTotal} > ${paymentAllocated} + ${paymentRefunded})`,
      ];
      if (filter.customerId) conds.push(eq(partners.id, filter.customerId));
      // 販売先の数だけの行なので、すべて読んでからページに分ける（件数のための2回目の集計をしない）
      const all = db
        .select({
          customerId: partners.id,
          customerName: partners.name,
          openTotal: sql<number>`coalesce(${open.total}, 0)`,
          openAllocated: sql<number>`coalesce(${open.allocated}, 0)`,
          overdueTotal: sql<number>`coalesce(${open.overdueTotal}, 0)`,
          overdueAllocated: sql<number>`coalesce(${open.overdueAllocated}, 0)`,
          openCount: sql<number>`coalesce(${open.count}, 0)`,
          overdueCount: sql<number>`coalesce(${open.overdueCount}, 0)`,
          nextDueOn: sql<string | null>`${open.nextDueOn}`,
          paymentTotal,
          paymentAllocated,
          paymentRefunded,
        })
        .from(partners)
        .leftJoin(open, eq(open.customerId, partners.id))
        .leftJoin(paid, eq(paid.customerId, partners.id))
        .leftJoin(used, eq(used.customerId, partners.id))
        .leftJoin(refunded, eq(refunded.customerId, partners.id))
        .where(and(...conds))
        .orderBy(asc(partners.kana), asc(partners.id))
        .all();
      const rows = all.slice((page - 1) * pageSize, page * pageSize);
      return { rows, total: all.length, page, pageSize };
    },
  };
}
