/**
 * ユースケースに渡す非同期処理（JobPort）と帳票（DocumentPort）の実装。業務 DB のトランザクションの中で使う。
 * 非同期処理は jobs（outbox）に登録し、コミット後に Queues へ送る（business-db.ts の dispatchJobs）。
 */
import { eq, sql } from "drizzle-orm";

import type { DocumentPort, JobPort, JobType } from "../../usecases/core";
import type { WriteMeta } from "../../usecases/ports";
import { auditInsert, type Db } from "../db/client";
import { documentSends, documents, jobs } from "../db/schema";

/** 登録した処理の ID は created に積む（コミット後に Queues へ送るため） */
export function jobPort(db: Db, meta: WriteMeta, nextId: () => string, created: string[]): JobPort {
  return {
    enqueue(type: JobType, payload: Record<string, unknown>, total = 0): string {
      const id = nextId();
      db.insert(jobs)
        .values({
          id,
          type,
          payloadJson: JSON.stringify(payload),
          status: "pending",
          total,
          ...auditInsert(meta),
        })
        .run();
      created.push(id);
      return id;
    },
  };
}

export function documentPort(
  db: Db,
  meta: WriteMeta,
  nextId: () => string,
  jobQueue: JobPort,
): DocumentPort {
  return {
    issue(input) {
      const id = nextId();
      db.insert(documents)
        .values({
          id,
          documentType: input.documentType,
          number: input.number,
          entityId: input.entityId,
          partnerId: input.partnerId,
          transactionDate: input.transactionDate,
          amount: input.amount,
          snapshotJson: JSON.stringify(input.snapshot),
          r2Key: null,
          status: "pending",
          ...auditInsert(meta),
        })
        .run();
      jobQueue.enqueue("render_document", { documentId: id });
      return id;
    },
    cancel(documentId) {
      db.update(documents)
        .set({
          cancelled: true,
          updatedAt: meta.at,
          updatedBy: meta.by,
          version: sql`${documents.version} + 1`,
        })
        .where(eq(documents.id, documentId))
        .run();
    },
    sendEmail(documentId, recipient) {
      const id = nextId();
      const jobId = jobQueue.enqueue("send_document", { sendId: id });
      db.insert(documentSends)
        .values({
          id,
          documentId,
          method: "email",
          recipient,
          status: "pending",
          jobId,
          ...auditInsert(meta),
        })
        .run();
      return id;
    },
    recordManualSend(documentId, note) {
      const id = nextId();
      db.insert(documentSends)
        .values({
          id,
          documentId,
          method: "manual",
          recipient: null,
          status: "sent",
          sentAt: meta.at,
          note,
          ...auditInsert(meta),
        })
        .run();
      return id;
    },
  };
}
