import { enc, withQuery, type Query } from "./query";

/** 帳票・処理状況など共通の仕組みの画面 */
export const platformPaths = {
  jobs: (query?: Query) => withQuery("/jobs", query),
  job: (id: string) => `/jobs/${enc(id)}`,
  jobDownload: (id: string) => `/jobs/${enc(id)}/download`,

  documents: (query?: Query) => withQuery("/documents", query),
  documentsCsv: () => "/documents/csv",
  documentsBulk: () => "/documents/bulk",
  document: (id: string, query?: Query) => withQuery(`/documents/${enc(id)}`, query),
  documentDownload: (id: string) => `/documents/${enc(id)}/download`,
  /** 送付の欄（送付の操作と送付履歴）。GET で部分 HTML、POST で送付 */
  documentSends: (id: string) => `/documents/${enc(id)}/sends`,
  documentSendRetry: (id: string, sendId: string) =>
    `/documents/${enc(id)}/sends/${enc(sendId)}/retry`,
  documentRerender: (id: string) => `/documents/${enc(id)}/rerender`,

  /** 操作履歴の検索（管理者だけ） */
  auditLogs: (query?: Query) => withQuery("/audit-logs", query),

  /** 業務 DB を特定の時点に戻す（管理者だけ。docs/operations.md 3章） */
  restore: (query?: Query) => withQuery("/admin/restore", query),
  restoreRecord: (id: string) => `/admin/restore/${enc(id)}`,
  restoreComplete: (id: string) => `/admin/restore/${enc(id)}/complete`,
};
