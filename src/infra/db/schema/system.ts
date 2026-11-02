import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { auditColumns, id } from "./common";

/** 採番（種別×年ごとの次の番号） */
export const sequences = sqliteTable("sequences", {
  key: text("key").primaryKey(),
  nextValue: integer("next_value").notNull(),
});

/** 処理済みの受付番号（冪等キー）と、その結果 */
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    key: text("key").primaryKey(),
    command: text("command").notNull(),
    employeeId: text("employee_id").notNull(),
    resultJson: text("result_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idempotency_keys_created").on(t.createdAt)],
);

/** 操作履歴（誰が・いつ・何を・変更前後の値） */
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: id(),
    occurredAt: text("occurred_at").notNull(),
    employeeId: text("employee_id").notNull(),
    command: text("command").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
  },
  (t) => [
    index("audit_logs_entity").on(t.entityType, t.entityId),
    index("audit_logs_occurred").on(t.occurredAt),
    // 操作履歴の検索（/audit-logs）で、操作した人・操作で絞り込んで新しい順に並べる
    index("audit_logs_employee").on(t.employeeId, t.occurredAt),
    index("audit_logs_action").on(t.action, t.occurredAt),
  ],
);

/** 発行済み帳票の索引（電子帳簿保存法の検索：取引年月日・金額・取引先） */
export const documents = sqliteTable(
  "documents",
  {
    id: id(),
    documentType: text("document_type", {
      enum: ["purchase_order", "delivery_note", "invoice", "credit_note"],
    }).notNull(),
    number: text("number").notNull(),
    entityId: text("entity_id").notNull(),
    partnerId: text("partner_id").notNull(),
    transactionDate: text("transaction_date").notNull(),
    amount: integer("amount").notNull(),
    /** 発行時点の帳票の内容（JSON）。PDF はこれから作る */
    snapshotJson: text("snapshot_json").notNull(),
    r2Key: text("r2_key"),
    status: text("status", { enum: ["pending", "ready", "failed"] }).notNull(),
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    index("documents_search").on(t.transactionDate, t.partnerId),
    index("documents_entity").on(t.documentType, t.entityId),
    // ダッシュボードの「PDF の作成に失敗した帳票」の件数（帳票をすべて読まない）
    index("documents_status").on(t.status),
  ],
);

/** 送付履歴 */
export const documentSends = sqliteTable(
  "document_sends",
  {
    id: id(),
    documentId: text("document_id").notNull(),
    method: text("method", { enum: ["email", "manual"] }).notNull(),
    recipient: text("recipient"),
    status: text("status", { enum: ["pending", "sent", "failed"] }).notNull(),
    error: text("error"),
    sentAt: text("sent_at"),
    note: text("note"),
    jobId: text("job_id"),
    ...auditColumns,
  },
  (t) => [
    index("document_sends_document").on(t.documentId),
    index("document_sends_status").on(t.status),
  ],
);

/** 非同期処理（Queues）の処理状況。業務の書き込みと同じトランザクションで登録する（outbox）。 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status", {
      enum: ["pending", "queued", "running", "succeeded", "failed"],
    }).notNull(),
    progress: integer("progress").notNull().default(0),
    total: integer("total").notNull().default(0),
    resultKey: text("result_key"),
    resultName: text("result_name"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    ...auditColumns,
  },
  (t) => [index("jobs_status").on(t.status, t.createdAt)],
);
