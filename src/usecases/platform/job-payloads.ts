/**
 * 非同期処理（Queues）に渡す内容のスキーマ。登録する側（ユースケース）と処理する側（infra/queue）で共有し、
 * 処理する側では必ずこのスキーマで検証してから使う（AGENTS.md 4章 外部から来る値）。
 */
import { z } from "zod";

import { idSchema } from "../schemas";

/** 帳票の PDF 化（ctx.documents.issue が登録する） */
export const renderDocumentPayload = z.object({ documentId: idSchema });

/** 帳票のメール送付（ctx.documents.sendEmail が登録する） */
export const sendDocumentPayload = z.object({ sendId: idSchema });

export const BULK_DOCUMENTS_MAX = 500;

/**
 * 一括 PDF。帳票をこの順に1つの PDF にまとめる。
 * 他の区分のユースケースから直接登録する場合は `ctx.jobs.enqueue("bulk_documents", payload, documentIds.length)`。
 */
export const bulkDocumentsPayload = z.object({
  documentIds: z.array(idSchema).min(1).max(BULK_DOCUMENTS_MAX),
  /** ダウンロードするときのファイル名（拡張子なし） */
  name: z.string().trim().min(1).max(100),
});
export type BulkDocumentsPayload = z.output<typeof bulkDocumentsPayload>;

/** CSV の非同期出力。definition は web/csv-exports.ts の一覧の名前、input は一覧の絞り込み条件 */
export const exportCsvPayload = z.object({
  definition: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9.]*$/)
    .max(64),
  input: z.record(z.string(), z.unknown()),
});
