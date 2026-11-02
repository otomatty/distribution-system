import { and, count, desc, eq, gte, lte, ne, sql, type SQL } from "drizzle-orm";

import type { SendMethod, SendStatus } from "../../../../domain/documents";
import type {
  DocumentFilter,
  DocumentRecord,
  DocumentSendRecord,
  DocumentStore,
  DocumentSummary,
} from "../../../../usecases/platform/documents.port";
import type { Page } from "../../../../usecases/schemas";
import { likePattern, type Db } from "../../client";
import { documentSends, documents, employees, jobs, partners } from "../../schema";
import { inList } from "../../sql-helpers";

/** 帳票ごとの最新の送付（ULID は作成順に並ぶので、ID の大きいものが最新） */
const lastSendStatus = sql<SendStatus | null>`(SELECT s.status FROM ${documentSends} s WHERE s.document_id = ${documents.id} ORDER BY s.id DESC LIMIT 1)`;
const lastSendMethod = sql<SendMethod | null>`(SELECT s.method FROM ${documentSends} s WHERE s.document_id = ${documents.id} ORDER BY s.id DESC LIMIT 1)`;

const summaryColumns = {
  id: documents.id,
  documentType: documents.documentType,
  number: documents.number,
  entityId: documents.entityId,
  partnerId: documents.partnerId,
  partnerName: partners.name,
  transactionDate: documents.transactionDate,
  amount: documents.amount,
  status: documents.status,
  cancelled: documents.cancelled,
  createdAt: documents.createdAt,
  lastSendStatus,
  lastSendMethod,
};

function conditions(filter: DocumentFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter.dateFrom) conds.push(gte(documents.transactionDate, filter.dateFrom));
  if (filter.dateTo) conds.push(lte(documents.transactionDate, filter.dateTo));
  if (filter.amountMin !== undefined) conds.push(gte(documents.amount, filter.amountMin));
  if (filter.amountMax !== undefined) conds.push(lte(documents.amount, filter.amountMax));
  if (filter.partnerId) conds.push(eq(documents.partnerId, filter.partnerId));
  if (filter.partnerQuery) {
    const p = likePattern(filter.partnerQuery);
    conds.push(
      sql`${documents.partnerId} IN (SELECT p.id FROM ${partners} p WHERE p.name LIKE ${p} ESCAPE '\\' OR p.kana LIKE ${p} ESCAPE '\\')`,
    );
  }
  if (filter.documentType) conds.push(eq(documents.documentType, filter.documentType));
  if (filter.documentTypes) conds.push(inList(documents.documentType, filter.documentTypes));
  if (filter.number) {
    conds.push(sql`${documents.number} LIKE ${likePattern(filter.number)} ESCAPE '\\'`);
  }
  if (filter.cancelled === "exclude") conds.push(eq(documents.cancelled, false));
  if (filter.cancelled === "only") conds.push(eq(documents.cancelled, true));
  if (filter.renderStatus) conds.push(eq(documents.status, filter.renderStatus));
  if (filter.sendStatus === "unsent") {
    conds.push(
      sql`NOT EXISTS (SELECT 1 FROM ${documentSends} s WHERE s.document_id = ${documents.id})`,
    );
  } else if (filter.sendStatus) {
    conds.push(sql`${lastSendStatus} = ${filter.sendStatus}`);
  }
  return conds.length > 0 ? and(...conds) : undefined;
}

type SendRow = typeof documentSends.$inferSelect & { createdByName: string | null };

function toSend(r: SendRow, isLatest: boolean): DocumentSendRecord {
  return {
    id: r.id,
    documentId: r.documentId,
    method: r.method,
    recipient: r.recipient,
    status: r.status,
    error: r.error,
    sentAt: r.sentAt,
    note: r.note,
    createdAt: r.createdAt,
    createdByName: r.createdByName,
    isLatest,
  };
}

export function documentStore(db: Db): DocumentStore {
  const sendColumns = {
    id: documentSends.id,
    documentId: documentSends.documentId,
    method: documentSends.method,
    recipient: documentSends.recipient,
    status: documentSends.status,
    error: documentSends.error,
    sentAt: documentSends.sentAt,
    note: documentSends.note,
    jobId: documentSends.jobId,
    createdAt: documentSends.createdAt,
    createdBy: documentSends.createdBy,
    updatedAt: documentSends.updatedAt,
    updatedBy: documentSends.updatedBy,
    version: documentSends.version,
    createdByName: employees.name,
  };
  return {
    search(filter, page, pageSize): Page<DocumentSummary> {
      const where = conditions(filter);
      const total = db.select({ n: count() }).from(documents).where(where).get()?.n ?? 0;
      const rows = db
        .select(summaryColumns)
        .from(documents)
        .leftJoin(partners, eq(partners.id, documents.partnerId))
        .where(where)
        .orderBy(desc(documents.transactionDate), desc(documents.number), desc(documents.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();
      return { rows, total, page, pageSize };
    },
    count(filter) {
      return db.select({ n: count() }).from(documents).where(conditions(filter)).get()?.n ?? 0;
    },
    get(id): DocumentRecord | undefined {
      return db
        .select({
          ...summaryColumns,
          r2Key: documents.r2Key,
          createdByName: employees.name,
          updatedAt: documents.updatedAt,
          version: documents.version,
        })
        .from(documents)
        .leftJoin(partners, eq(partners.id, documents.partnerId))
        .leftJoin(employees, eq(employees.id, documents.createdBy))
        .where(eq(documents.id, id))
        .get();
    },
    existingIds(ids) {
      if (ids.length === 0) return [];
      const found = new Set(
        db
          .select({ id: documents.id })
          .from(documents)
          .where(inList(documents.id, ids))
          .all()
          .map((r) => r.id),
      );
      return ids.filter((id) => found.has(id));
    },
    latestForEntities(type, entityIds) {
      if (entityIds.length === 0) return [];
      const latest = new Map<string, string>();
      const rows = db
        .select({ id: documents.id, entityId: documents.entityId })
        .from(documents)
        .where(
          and(
            eq(documents.documentType, type),
            inList(documents.entityId, entityIds),
            eq(documents.cancelled, false),
          ),
        )
        .orderBy(desc(documents.id))
        .all();
      for (const r of rows) if (!latest.has(r.entityId)) latest.set(r.entityId, r.id);
      return entityIds.flatMap((e) => {
        const id = latest.get(e);
        return id === undefined ? [] : [id];
      });
    },
    sends(documentId) {
      return db
        .select(sendColumns)
        .from(documentSends)
        .leftJoin(employees, eq(employees.id, documentSends.createdBy))
        .where(eq(documentSends.documentId, documentId))
        .orderBy(desc(documentSends.id))
        .all()
        .map((r, i) => toSend(r, i === 0));
    },
    getSend(id) {
      const r = db
        .select(sendColumns)
        .from(documentSends)
        .leftJoin(employees, eq(employees.id, documentSends.createdBy))
        .where(eq(documentSends.id, id))
        .get();
      if (!r) return undefined;
      const newer = db
        .select({ id: documentSends.id })
        .from(documentSends)
        .where(and(eq(documentSends.documentId, r.documentId), sql`${documentSends.id} > ${r.id}`))
        .limit(1)
        .get();
      return toSend(r, newer === undefined);
    },
    renderError(documentId) {
      const r = db
        .select({ error: jobs.error })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, "render_document"),
            eq(jobs.status, "failed"),
            sql`json_extract(${jobs.payloadJson}, '$.documentId') = ${documentId}`,
          ),
        )
        .orderBy(desc(jobs.createdAt), desc(jobs.id))
        .limit(1)
        .get();
      return r?.error ?? null;
    },
    resetRender(id, meta) {
      db.update(documents)
        .set({
          status: "pending",
          version: sql`${documents.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(documents.id, id), ne(documents.status, "ready")))
        .run();
    },
  };
}
