import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";

import type { TaxCategory } from "../../../../domain/money";
import type {
  ClosingCustomer,
  InvoiceDetail,
  InvoiceDocumentRef,
  InvoiceFilter,
  InvoiceListRow,
  InvoiceRecord,
  InvoiceStore,
  InvoiceTaxGroup,
} from "../../../../usecases/billing/invoices.port";
import type { WriteMeta } from "../../../../usecases/ports";
import { auditInsert, likePattern, type Db } from "../../client";
import {
  customerPayments,
  documentSends,
  documents,
  invoiceLines,
  invoices,
  partners,
  paymentAllocations,
  salesOrders,
  salesReturns,
  shipments,
} from "../../schema";
import { inList, insertBatches } from "../../sql-helpers";

type Row = typeof invoices.$inferSelect;

const OPEN_STATUSES = ["unpaid", "partial"];

function taxCategoryOf(value: string): TaxCategory {
  return value === "reduced" ? "reduced" : "standard";
}

function taxGroups(json: Row["taxSummary"]): InvoiceTaxGroup[] {
  return json.map((g) => ({
    category: taxCategoryOf(g.category),
    rateBps: g.rateBps,
    subtotal: g.subtotal,
    tax: g.tax,
  }));
}

function toRecord(r: Row): InvoiceRecord {
  return {
    id: r.id,
    number: r.number,
    customerId: r.customerId,
    issuedOn: r.issuedOn,
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    dueOn: r.dueOn,
    subtotal: r.subtotal,
    tax: r.tax,
    total: r.total,
    taxSummary: taxGroups(r.taxSummary),
    roundingMode: r.roundingMode,
    recipientSnapshot: r.recipientSnapshot,
    issuerSnapshot: r.issuerSnapshot,
    allocated: r.allocated,
    status: r.status,
    reissuedFromId: r.reissuedFromId,
    cancelReason: r.cancelReason,
    version: r.version,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    updatedAt: r.updatedAt,
  };
}

/*
 * 相関サブクエリの外側の列は "表"."列" で書く（drizzle は結合のない SELECT では列名だけを出すため、
 * サブクエリの中の同じ名前の列と取り違える）
 */

function conditions(filter: InvoiceFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.status) conds.push(eq(invoices.status, filter.status));
  if (filter.open) conds.push(inList(invoices.status, OPEN_STATUSES));
  if (filter.excludeCancelled) conds.push(ne(invoices.status, "cancelled"));
  if (filter.customerId) conds.push(eq(invoices.customerId, filter.customerId));
  if (filter.issuedFrom) conds.push(gte(invoices.issuedOn, filter.issuedFrom));
  if (filter.issuedTo) conds.push(lte(invoices.issuedOn, filter.issuedTo));
  if (filter.dueTo) conds.push(lte(invoices.dueOn, filter.dueTo));
  if (filter.overdueAsOf) {
    conds.push(
      inList(invoices.status, OPEN_STATUSES),
      isNotNull(invoices.dueOn),
      lt(invoices.dueOn, filter.overdueAsOf),
    );
  }
  if (filter.number)
    conds.push(sql`${invoices.number} LIKE ${likePattern(filter.number)} ESCAPE '\\'`);
  if (filter.sendStatus) conds.push(latestSendIs(filter.sendStatus));
  return conds.length > 0 ? and(...conds) : undefined;
}

/**
 * 最新の帳票の最新の送付の結果が status の請求書。結果が status の送付から探す
 * （請求書ごとに最新の帳票と送付を調べると、請求書の数だけ読む。ダッシュボードの「送付に失敗した請求書」。docs/performance.md）
 */
function latestSendIs(status: string): SQL {
  return sql`${invoices.id} IN (SELECT d.entity_id FROM ${documentSends} s
    INNER JOIN ${documents} d ON d.id = s.document_id
    WHERE s.status = ${status} AND d.document_type = 'invoice'
      AND NOT EXISTS (SELECT 1 FROM ${documentSends} s2 WHERE s2.document_id = s.document_id AND s2.id > s.id)
      AND NOT EXISTS (SELECT 1 FROM ${documents} d2
        WHERE d2.document_type = 'invoice' AND d2.entity_id = d.entity_id AND d2.id > d.id))`;
}

function stamp(meta: WriteMeta, table: typeof shipments | typeof salesReturns | typeof invoices) {
  return { version: sql`${table.version} + 1`, updatedAt: meta.at, updatedBy: meta.by };
}

export function invoiceStore(db: Db): InvoiceStore {
  /** 請求書ごとの最新の帳票と、その最新の送付の結果 */
  function latestDocuments(ids: readonly string[]): Map<string, InvoiceDocumentRef> {
    const out = new Map<string, InvoiceDocumentRef>();
    if (ids.length === 0) return out;
    const docs = db
      .select({
        id: documents.id,
        entityId: documents.entityId,
        status: documents.status,
        cancelled: documents.cancelled,
      })
      .from(documents)
      .where(and(eq(documents.documentType, "invoice"), inList(documents.entityId, ids)))
      .orderBy(desc(documents.id))
      .all();
    const latest = docs.filter((d, i) => docs.findIndex((x) => x.entityId === d.entityId) === i);
    const sends = new Map<string, "pending" | "sent" | "failed">();
    if (latest.length > 0) {
      const rows = db
        .select({ documentId: documentSends.documentId, status: documentSends.status })
        .from(documentSends)
        .where(
          inList(
            documentSends.documentId,
            latest.map((d) => d.id),
          ),
        )
        .orderBy(desc(documentSends.id))
        .all();
      for (const r of rows) if (!sends.has(r.documentId)) sends.set(r.documentId, r.status);
    }
    for (const d of latest) {
      out.set(d.entityId, {
        documentId: d.id,
        status: d.status,
        cancelled: d.cancelled,
        lastSendStatus: sends.get(d.id) ?? null,
      });
    }
    return out;
  }

  return {
    get(id): InvoiceDetail | undefined {
      const head = db
        .select({ invoice: invoices, customerName: partners.name })
        .from(invoices)
        .innerJoin(partners, eq(partners.id, invoices.customerId))
        .where(eq(invoices.id, id))
        .get();
      if (!head) return undefined;
      const record = toRecord(head.invoice);
      const reissuedFrom = record.reissuedFromId
        ? db
            .select({ number: invoices.number })
            .from(invoices)
            .where(eq(invoices.id, record.reissuedFromId))
            .get()
        : undefined;
      const reissuedTo = db
        .select({ id: invoices.id, number: invoices.number })
        .from(invoices)
        .where(eq(invoices.reissuedFromId, id))
        .orderBy(asc(invoices.id))
        .all();
      const lines = db
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id))
        .orderBy(asc(invoiceLines.lineNo))
        .all()
        .map((l) => ({
          lineNo: l.lineNo,
          sourceType: l.sourceType,
          sourceId: l.sourceId,
          transactionDate: l.transactionDate,
          description: l.description,
          quantity: l.quantity,
          unitName: l.unitName,
          unitPriceCenti: l.unitPriceCenti,
          amount: l.amount,
          taxCategory: l.taxCategory,
        }));
      const shipped = db
        .select({
          id: shipments.id,
          version: shipments.version,
          shippedOn: shipments.shippedOn,
          deliveryNoteNumber: shipments.deliveryNoteNumber,
          salesOrderId: shipments.salesOrderId,
          salesOrderNumber: salesOrders.number,
        })
        .from(shipments)
        .innerJoin(salesOrders, eq(salesOrders.id, shipments.salesOrderId))
        .where(eq(shipments.invoiceId, id))
        .orderBy(asc(shipments.shippedOn), asc(shipments.deliveryNoteNumber))
        .all();
      const returns = db
        .select({
          id: salesReturns.id,
          number: salesReturns.number,
          returnedOn: salesReturns.returnedOn,
          salesOrderId: salesReturns.salesOrderId,
          creditNoteNumber: salesReturns.creditNoteNumber,
        })
        .from(salesReturns)
        .where(eq(salesReturns.invoiceId, id))
        .orderBy(asc(salesReturns.returnedOn), asc(salesReturns.number))
        .all();
      const allocations = db
        .select({
          id: paymentAllocations.id,
          paymentId: paymentAllocations.paymentId,
          receivedOn: customerPayments.receivedOn,
          method: customerPayments.method,
          salesReturnId: customerPayments.salesReturnId,
          amount: paymentAllocations.amount,
          adjustment: paymentAllocations.adjustment,
          adjustmentKind: paymentAllocations.adjustmentKind,
          cancelled: paymentAllocations.cancelled,
          version: paymentAllocations.version,
          createdAt: paymentAllocations.createdAt,
        })
        .from(paymentAllocations)
        .innerJoin(customerPayments, eq(customerPayments.id, paymentAllocations.paymentId))
        .where(eq(paymentAllocations.invoiceId, id))
        .orderBy(desc(paymentAllocations.id))
        .all();
      return {
        ...record,
        customerName: head.customerName,
        reissuedFromNumber: reissuedFrom?.number ?? null,
        reissuedTo,
        lines,
        shipments: shipped,
        returns,
        allocations,
        document: latestDocuments([id]).get(id) ?? null,
      };
    },
    list(filter, order, page, pageSize) {
      const where = conditions(filter);
      const total = db.select({ n: count() }).from(invoices).where(where).get()?.n ?? 0;
      const orderBy =
        order === "due"
          ? [asc(sql`${invoices.dueOn} IS NULL`), asc(invoices.dueOn), asc(invoices.number)]
          : [desc(invoices.issuedOn), desc(invoices.number)];
      const rows = db
        .select({ invoice: invoices, customerName: partners.name })
        .from(invoices)
        .innerJoin(partners, eq(partners.id, invoices.customerId))
        .where(where)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      const docs = latestDocuments(rows.map((r) => r.invoice.id));
      return {
        rows: rows.map((r): InvoiceListRow =>
          Object.assign(toRecord(r.invoice), {
            customerName: r.customerName,
            document: docs.get(r.invoice.id) ?? null,
          }),
        ),
        total,
        page,
        pageSize,
      };
    },
    count(filter) {
      return db.select({ n: count() }).from(invoices).where(conditions(filter)).get()?.n ?? 0;
    },
    openForCustomer(customerId) {
      return db
        .select()
        .from(invoices)
        .where(and(eq(invoices.customerId, customerId), inList(invoices.status, OPEN_STATUSES)))
        .orderBy(
          asc(sql`${invoices.dueOn} IS NULL`),
          asc(invoices.dueOn),
          asc(invoices.issuedOn),
          asc(invoices.number),
        )
        .all()
        .map(toRecord);
    },
    insert(record, lines, meta) {
      db.insert(invoices)
        .values({
          ...record,
          taxSummary: record.taxSummary.map((g) => ({ ...g })),
          recipientSnapshot: { ...record.recipientSnapshot },
          issuerSnapshot: { ...record.issuerSnapshot },
          pdfKey: null,
          ...auditInsert(meta),
        })
        .run();
      const values = lines.map((l) => ({ invoiceId: record.id, ...l }));
      for (const batch of insertBatches(values, 12)) db.insert(invoiceLines).values(batch).run();
    },
    update(id, expectedVersion, patch, meta) {
      const rows = db
        .update(invoices)
        .set({ ...patch, ...stamp(meta, invoices) })
        .where(and(eq(invoices.id, id), eq(invoices.version, expectedVersion)))
        .returning({ id: invoices.id })
        .all();
      return rows.length === 1;
    },
    attachShipments(invoiceId, refs, meta) {
      let n = 0;
      for (const ref of refs) {
        const rows = db
          .update(shipments)
          .set({ invoiceId, ...stamp(meta, shipments) })
          .where(
            and(
              eq(shipments.id, ref.id),
              eq(shipments.version, ref.version),
              isNull(shipments.invoiceId),
              eq(shipments.cancelled, false),
            ),
          )
          .returning({ id: shipments.id })
          .all();
        n += rows.length;
      }
      return n;
    },
    detachShipments(invoiceId, meta) {
      return db
        .update(shipments)
        .set({ invoiceId: null, ...stamp(meta, shipments) })
        .where(eq(shipments.invoiceId, invoiceId))
        .returning({ id: shipments.id })
        .all()
        .map((r) => r.id);
    },
    attachReturns(invoiceId, refs, meta) {
      let n = 0;
      for (const ref of refs) {
        const rows = db
          .update(salesReturns)
          .set({ invoiceId, ...stamp(meta, salesReturns) })
          .where(
            and(
              eq(salesReturns.id, ref.id),
              eq(salesReturns.version, ref.version),
              isNull(salesReturns.invoiceId),
              eq(salesReturns.cancelled, false),
            ),
          )
          .returning({ id: salesReturns.id })
          .all();
        n += rows.length;
      }
      return n;
    },
    detachReturns(invoiceId, meta) {
      return db
        .update(salesReturns)
        .set({ invoiceId: null, ...stamp(meta, salesReturns) })
        .where(eq(salesReturns.invoiceId, invoiceId))
        .returning({ id: salesReturns.id })
        .all()
        .map((r) => r.id);
    },
    closingCustomers(customerId) {
      // 最も古い未請求の発送の日は、未請求の発送を1回だけ集計して販売先ごとに求める
      // （販売先ごとの副問い合わせでは、販売先の数 × 未請求の発送を読み、本番の5倍の量で数秒かかる。docs/performance.md）
      const unbilledConds: SQL[] = [eq(shipments.cancelled, false), isNull(shipments.invoiceId)];
      if (customerId) unbilledConds.push(eq(salesOrders.customerId, customerId));
      const unbilled = db
        .select({
          customerId: sql<string>`${salesOrders.customerId}`.as("unbilled_customer_id"),
          oldest: sql<string>`min(${shipments.shippedOn})`.as("oldest_unbilled_on"),
        })
        .from(shipments)
        .innerJoin(salesOrders, eq(salesOrders.id, shipments.salesOrderId))
        .where(and(...unbilledConds))
        .groupBy(salesOrders.customerId)
        .as("unbilled");
      const conds: SQL[] = [
        eq(partners.isCustomer, true),
        isNotNull(partners.closingDay),
        isNotNull(partners.paymentMonthOffset),
        isNotNull(partners.paymentDay),
      ];
      if (customerId) conds.push(eq(partners.id, customerId));
      return db
        .select({
          id: partners.id,
          name: partners.name,
          kana: partners.kana,
          archived: partners.archived,
          closingDay: partners.closingDay,
          paymentMonthOffset: partners.paymentMonthOffset,
          paymentDay: partners.paymentDay,
          oldestUnbilledOn: unbilled.oldest,
        })
        .from(partners)
        .leftJoin(unbilled, eq(unbilled.customerId, partners.id))
        .where(and(...conds))
        .orderBy(asc(partners.kana), asc(partners.id))
        .all()
        .flatMap((r): ClosingCustomer[] =>
          r.closingDay === null ||
          r.paymentMonthOffset === null ||
          r.paymentDay === null ||
          (r.archived && r.oldestUnbilledOn === null)
            ? []
            : [
                {
                  id: r.id,
                  name: r.name,
                  kana: r.kana,
                  closingDay: r.closingDay,
                  paymentMonthOffset: r.paymentMonthOffset,
                  paymentDay: r.paymentDay,
                  oldestUnbilledOn: r.oldestUnbilledOn,
                },
              ],
        );
    },
  };
}
