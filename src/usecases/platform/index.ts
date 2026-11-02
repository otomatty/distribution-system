/** 共通の仕組み（帳票・送付・処理状況・CSV・バックアップ・ダッシュボード・操作履歴）のユースケース。追加したら下の一覧に1行ずつ登録する */
import { searchAuditLogs } from "./audit-logs";
import {
  documentAttention,
  getDocument,
  recordManualSend,
  rerenderDocument,
  retrySend,
  searchDocuments,
  sendDocument,
} from "./documents";
import { enqueueBulkDocuments, enqueueCsvExport, getJob, jobAttention, listJobs } from "./jobs";

export const platformCommands = {
  "documents.send": sendDocument,
  "documents.recordManualSend": recordManualSend,
  "documents.retrySend": retrySend,
  "documents.rerender": rerenderDocument,
  "jobs.bulkDocuments": enqueueBulkDocuments,
  "jobs.exportCsv": enqueueCsvExport,
} as const;

export const platformQueries = {
  "documents.search": searchDocuments,
  "documents.get": getDocument,
  "documents.attention": documentAttention,
  "jobs.list": listJobs,
  "jobs.get": getJob,
  "jobs.attention": jobAttention,
  "auditLogs.search": searchAuditLogs,
} as const;
