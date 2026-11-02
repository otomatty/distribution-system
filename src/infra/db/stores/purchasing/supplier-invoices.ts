import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { AmountLine, TaxCategory } from "../../../../domain/money";
import type {
  InvoiceReceiptRow,
  InvoiceReturnRow,
  MonthlyPayable,
  SupplierInvoiceFilter,
  SupplierInvoiceRecord,
  SupplierInvoiceStore,
  SupplierPaymentRecord,
} from "../../../../usecases/purchasing/supplier-invoices.port";
import { auditInsert, likePattern, type Db } from "../../client";
import {
  employees,
  partners,
  purchaseOrders,
  purchaseReturnLines,
  purchaseReturns,
  receiptLines,
  receipts,
  supplierInvoices,
  supplierPayments,
} from "../../schema";
import { inList } from "../../sql-helpers";

/** 受入のある（受入数 × 単価の請求がある）入荷 */
const hasAccepted = sql`EXISTS (SELECT 1 FROM ${receiptLines} rl WHERE rl.receipt_id = ${receipts.id} AND rl.accepted > 0)`;

function conditions(filter: SupplierInvoiceFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.status) conds.push(eq(supplierInvoices.status, filter.status));
  if (filter.supplierId) conds.push(eq(supplierInvoices.supplierId, filter.supplierId));
  if (filter.from) conds.push(gte(supplierInvoices.invoiceDate, filter.from));
  if (filter.to) conds.push(lte(supplierInvoices.invoiceDate, filter.to));
  if (filter.dueFrom) conds.push(gte(supplierInvoices.paymentDueOn, filter.dueFrom));
  if (filter.dueTo) conds.push(lte(supplierInvoices.paymentDueOn, filter.dueTo));
  if (filter.q) {
    const p = likePattern(filter.q);
    const c = or(
      sql`${supplierInvoices.invoiceNumber} LIKE ${p} ESCAPE '\\'`,
      sql`${partners.name} LIKE ${p} ESCAPE '\\'`,
      sql`${partners.kana} LIKE ${p} ESCAPE '\\'`,
    );
    if (c) conds.push(c);
  }
  return conds.length > 0 ? and(...conds) : undefined;
}

function groupAmounts<K extends string>(
  rows: readonly { key: K; taxCategory: TaxCategory; amount: number }[],
): Map<K, AmountLine[]> {
  const out = new Map<K, AmountLine[]>();
  for (const r of rows) {
    out.set(r.key, [...(out.get(r.key) ?? []), { taxCategory: r.taxCategory, amount: r.amount }]);
  }
  return out;
}

export function supplierInvoiceStore(db: Db): SupplierInvoiceStore {
  const paymentColumns = {
    id: supplierPayments.id,
    paidOn: supplierPayments.paidOn,
    amount: supplierPayments.amount,
    memo: supplierPayments.memo,
    cancelled: supplierPayments.cancelled,
    cancelReason: supplierPayments.cancelReason,
    createdAt: supplierPayments.createdAt,
    createdByName: employees.name,
  };

  function activePayments(invoiceIds: readonly string[]): Map<string, SupplierPaymentRecord> {
    const out = new Map<string, SupplierPaymentRecord>();
    if (invoiceIds.length === 0) return out;
    const rows = db
      .select({ invoiceId: supplierPayments.supplierInvoiceId, ...paymentColumns })
      .from(supplierPayments)
      .leftJoin(employees, eq(employees.id, supplierPayments.createdBy))
      .where(
        and(
          inList(supplierPayments.supplierInvoiceId, invoiceIds),
          eq(supplierPayments.cancelled, false),
        ),
      )
      .orderBy(asc(supplierPayments.id))
      .all();
    for (const { invoiceId, ...p } of rows) out.set(invoiceId, p);
    return out;
  }

  const recordColumns = {
    id: supplierInvoices.id,
    supplierId: supplierInvoices.supplierId,
    invoiceNumber: supplierInvoices.invoiceNumber,
    invoiceDate: supplierInvoices.invoiceDate,
    invoicedAmount: supplierInvoices.invoicedAmount,
    shippingFee: supplierInvoices.shippingFee,
    computedAmount: supplierInvoices.computedAmount,
    difference: supplierInvoices.difference,
    differenceReason: supplierInvoices.differenceReason,
    paymentDueOn: supplierInvoices.paymentDueOn,
    memo: supplierInvoices.memo,
    status: supplierInvoices.status,
    cancelReason: supplierInvoices.cancelReason,
    version: supplierInvoices.version,
    createdAt: supplierInvoices.createdAt,
    createdByName: employees.name,
    supplierName: sql<string>`coalesce(${partners.name}, '')`,
  };

  const base = () =>
    db
      .select(recordColumns)
      .from(supplierInvoices)
      .leftJoin(partners, eq(partners.id, supplierInvoices.supplierId))
      .leftJoin(employees, eq(employees.id, supplierInvoices.createdBy));

  function withPayments(
    rows: readonly Omit<SupplierInvoiceRecord, "payment">[],
  ): SupplierInvoiceRecord[] {
    const payments = activePayments(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, payment: payments.get(r.id) ?? null }));
  }

  function receiptRows(where: SQL | undefined): InvoiceReceiptRow[] {
    const headers = db
      .select({
        id: receipts.id,
        number: receipts.number,
        purchaseOrderId: receipts.purchaseOrderId,
        purchaseOrderNumber: sql<string>`coalesce(${purchaseOrders.number}, '')`,
        receivedOn: receipts.receivedOn,
      })
      .from(receipts)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, receipts.purchaseOrderId))
      .where(where)
      .orderBy(asc(receipts.receivedOn), asc(receipts.number))
      .all();
    if (headers.length === 0) return [];
    const amounts = groupAmounts(
      db
        .select({
          key: receiptLines.receiptId,
          taxCategory: receiptLines.taxCategory,
          amount: sql<number>`coalesce(sum(${receiptLines.amount}), 0)`,
        })
        .from(receiptLines)
        .where(
          inList(
            receiptLines.receiptId,
            headers.map((h) => h.id),
          ),
        )
        .groupBy(receiptLines.receiptId, receiptLines.taxCategory)
        .all(),
    );
    return headers.map((h) => Object.assign(h, { amounts: amounts.get(h.id) ?? [] }));
  }

  function returnRows(where: SQL | undefined): InvoiceReturnRow[] {
    const headers = db
      .select({
        id: purchaseReturns.id,
        number: purchaseReturns.number,
        purchaseOrderId: purchaseReturns.purchaseOrderId,
        purchaseOrderNumber: purchaseOrders.number,
        returnedOn: purchaseReturns.returnedOn,
      })
      .from(purchaseReturns)
      .leftJoin(purchaseOrders, eq(purchaseOrders.id, purchaseReturns.purchaseOrderId))
      .where(where)
      .orderBy(asc(purchaseReturns.returnedOn), asc(purchaseReturns.number))
      .all();
    if (headers.length === 0) return [];
    const amounts = groupAmounts(
      db
        .select({
          key: purchaseReturnLines.purchaseReturnId,
          taxCategory: purchaseReturnLines.taxCategory,
          amount: sql<number>`coalesce(sum(${purchaseReturnLines.amount}), 0)`,
        })
        .from(purchaseReturnLines)
        .where(
          inList(
            purchaseReturnLines.purchaseReturnId,
            headers.map((h) => h.id),
          ),
        )
        .groupBy(purchaseReturnLines.purchaseReturnId, purchaseReturnLines.taxCategory)
        .all(),
    );
    return headers.map((h) => Object.assign(h, { amounts: amounts.get(h.id) ?? [] }));
  }

  return {
    insert(id, fields, meta) {
      db.insert(supplierInvoices)
        .values({ id, ...fields, status: "unpaid", ...auditInsert(meta) })
        .run();
    },
    get(id) {
      const r = base().where(eq(supplierInvoices.id, id)).get();
      return r ? withPayments([r])[0] : undefined;
    },
    update(id, expectedVersion, patch, meta) {
      const rows = db
        .update(supplierInvoices)
        .set({
          ...patch,
          version: sql`${supplierInvoices.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.version, expectedVersion)))
        .returning({ id: supplierInvoices.id })
        .all();
      return rows.length === 1;
    },
    list(filter, page, pageSize) {
      const where = conditions(filter);
      const total =
        db
          .select({ n: count() })
          .from(supplierInvoices)
          .leftJoin(partners, eq(partners.id, supplierInvoices.supplierId))
          .where(where)
          .get()?.n ?? 0;
      const rows = base()
        .where(where)
        .orderBy(
          sql`${supplierInvoices.paymentDueOn} IS NULL`,
          asc(supplierInvoices.paymentDueOn),
          desc(supplierInvoices.invoiceDate),
          asc(supplierInvoices.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows: withPayments(rows), total, page, pageSize };
    },
    totals(filter) {
      const r = db
        .select({
          count: count(),
          amount: sql<number>`coalesce(sum(${supplierInvoices.invoicedAmount}), 0)`,
        })
        .from(supplierInvoices)
        .leftJoin(partners, eq(partners.id, supplierInvoices.supplierId))
        .where(conditions(filter))
        .get();
      return { count: r?.count ?? 0, amount: r?.amount ?? 0 };
    },
    candidates(supplierId) {
      return {
        receipts: receiptRows(
          and(
            eq(purchaseOrders.supplierId, supplierId),
            eq(receipts.cancelled, false),
            isNull(receipts.supplierInvoiceId),
            hasAccepted,
          ),
        ),
        returns: returnRows(
          and(
            eq(purchaseReturns.supplierId, supplierId),
            eq(purchaseReturns.cancelled, false),
            isNull(purchaseReturns.supplierInvoiceId),
          ),
        ),
      };
    },
    linkedReceipts(invoiceId) {
      return receiptRows(eq(receipts.supplierInvoiceId, invoiceId));
    },
    linkedReturns(invoiceId) {
      return returnRows(eq(purchaseReturns.supplierInvoiceId, invoiceId));
    },
    setReceiptInvoice(receiptIds, invoiceId) {
      if (receiptIds.length === 0) return;
      db.update(receipts)
        .set({ supplierInvoiceId: invoiceId })
        .where(inList(receipts.id, receiptIds))
        .run();
    },
    setReturnInvoice(returnIds, invoiceId) {
      if (returnIds.length === 0) return;
      db.update(purchaseReturns)
        .set({ supplierInvoiceId: invoiceId })
        .where(inList(purchaseReturns.id, returnIds))
        .run();
    },
    payments(invoiceId) {
      return db
        .select(paymentColumns)
        .from(supplierPayments)
        .leftJoin(employees, eq(employees.id, supplierPayments.createdBy))
        .where(eq(supplierPayments.supplierInvoiceId, invoiceId))
        .orderBy(desc(supplierPayments.id))
        .all();
    },
    insertPayment(id, invoiceId, payment, meta) {
      db.insert(supplierPayments)
        .values({
          id,
          supplierInvoiceId: invoiceId,
          paidOn: payment.paidOn,
          amount: payment.amount,
          memo: payment.memo,
          cancelled: false,
          ...auditInsert(meta),
        })
        .run();
    },
    cancelPayment(paymentId, reason, meta) {
      db.update(supplierPayments)
        .set({
          cancelled: true,
          cancelReason: reason,
          version: sql`${supplierPayments.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(eq(supplierPayments.id, paymentId))
        .run();
    },
    orderIds(invoiceId) {
      return db
        .selectDistinct({ id: receipts.purchaseOrderId })
        .from(receipts)
        .where(eq(receipts.supplierInvoiceId, invoiceId))
        .all()
        .map((r) => r.id);
    },
    unpaidReceiptCount(orderId) {
      return (
        db
          .select({ n: count() })
          .from(receipts)
          .leftJoin(supplierInvoices, eq(supplierInvoices.id, receipts.supplierInvoiceId))
          .where(
            and(
              eq(receipts.purchaseOrderId, orderId),
              eq(receipts.cancelled, false),
              hasAccepted,
              or(isNull(receipts.supplierInvoiceId), ne(supplierInvoices.status, "paid")),
            ),
          )
          .get()?.n ?? 0
      );
    },
    invoicesForOrder(orderId) {
      return db
        .selectDistinct({
          id: supplierInvoices.id,
          invoiceNumber: supplierInvoices.invoiceNumber,
          status: supplierInvoices.status,
        })
        .from(receipts)
        .innerJoin(supplierInvoices, eq(supplierInvoices.id, receipts.supplierInvoiceId))
        .where(and(eq(receipts.purchaseOrderId, orderId), ne(supplierInvoices.status, "cancelled")))
        .orderBy(asc(supplierInvoices.id))
        .all();
    },
    monthly(from, to, supplierId): MonthlyPayable[] {
      const invoiced = db
        .select({
          supplierId: supplierInvoices.supplierId,
          supplierName: sql<string>`coalesce(${partners.name}, '')`,
          month: sql<string>`substr(${supplierInvoices.invoiceDate}, 1, 7)`,
          amount: sql<number>`coalesce(sum(${supplierInvoices.invoicedAmount}), 0)`,
        })
        .from(supplierInvoices)
        .leftJoin(partners, eq(partners.id, supplierInvoices.supplierId))
        .where(
          and(
            ne(supplierInvoices.status, "cancelled"),
            gte(supplierInvoices.invoiceDate, from),
            lte(supplierInvoices.invoiceDate, to),
            supplierId ? eq(supplierInvoices.supplierId, supplierId) : undefined,
          ),
        )
        .groupBy(supplierInvoices.supplierId, sql`substr(${supplierInvoices.invoiceDate}, 1, 7)`)
        .all();
      const paid = db
        .select({
          supplierId: supplierInvoices.supplierId,
          supplierName: sql<string>`coalesce(${partners.name}, '')`,
          month: sql<string>`substr(${supplierPayments.paidOn}, 1, 7)`,
          amount: sql<number>`coalesce(sum(${supplierPayments.amount}), 0)`,
        })
        .from(supplierPayments)
        .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierPayments.supplierInvoiceId))
        .leftJoin(partners, eq(partners.id, supplierInvoices.supplierId))
        .where(
          and(
            eq(supplierPayments.cancelled, false),
            gte(supplierPayments.paidOn, from),
            lte(supplierPayments.paidOn, to),
            supplierId ? eq(supplierInvoices.supplierId, supplierId) : undefined,
          ),
        )
        .groupBy(supplierInvoices.supplierId, sql`substr(${supplierPayments.paidOn}, 1, 7)`)
        .all();
      const out: MonthlyPayable[] = [];
      for (const r of invoiced)
        out.push({
          supplierId: r.supplierId,
          supplierName: r.supplierName,
          month: r.month,
          invoiced: r.amount,
          paid: 0,
        });
      for (const r of paid)
        out.push({
          supplierId: r.supplierId,
          supplierName: r.supplierName,
          month: r.month,
          invoiced: 0,
          paid: r.amount,
        });
      return out;
    },
    openingBalances(before, supplierId) {
      const invoiced = db
        .select({
          supplierId: supplierInvoices.supplierId,
          supplierName: sql<string>`coalesce(${partners.name}, '')`,
          amount: sql<number>`coalesce(sum(${supplierInvoices.invoicedAmount}), 0)`,
        })
        .from(supplierInvoices)
        .leftJoin(partners, eq(partners.id, supplierInvoices.supplierId))
        .where(
          and(
            ne(supplierInvoices.status, "cancelled"),
            lt(supplierInvoices.invoiceDate, before),
            supplierId ? eq(supplierInvoices.supplierId, supplierId) : undefined,
          ),
        )
        .groupBy(supplierInvoices.supplierId)
        .all();
      const paid = db
        .select({
          supplierId: supplierInvoices.supplierId,
          amount: sql<number>`coalesce(sum(${supplierPayments.amount}), 0)`,
        })
        .from(supplierPayments)
        .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierPayments.supplierInvoiceId))
        .where(
          and(
            eq(supplierPayments.cancelled, false),
            lt(supplierPayments.paidOn, before),
            supplierId ? eq(supplierInvoices.supplierId, supplierId) : undefined,
          ),
        )
        .groupBy(supplierInvoices.supplierId)
        .all();
      const paidBy = new Map(paid.map((p) => [p.supplierId, p.amount]));
      return invoiced.map((r) => ({
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        balance: r.amount - (paidBy.get(r.supplierId) ?? 0),
      }));
    },
  };
}
