/** 非同期処理（一括 PDF、大きな CSV、帳票の PDF 化とメール送付、バックアップ）の決まり（要件定義書 5章 処理状況）。 */

export const JOB_TYPES = [
  "render_document",
  "send_document",
  "bulk_documents",
  "export_csv",
  "backup",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_TYPE_LABELS: Readonly<Record<JobType, string>> = {
  render_document: "帳票の PDF 化",
  send_document: "帳票のメール送付",
  bulk_documents: "一括 PDF",
  export_csv: "CSV 出力",
  backup: "日次バックアップ",
};

/**
 * 処理状況の画面に出す種類。帳票ごとの PDF 化とメール送付は帳票の画面で状況を示すので、ここには出さない。
 */
export const LISTED_JOB_TYPES: readonly JobType[] = ["bulk_documents", "export_csv", "backup"];

export type JobStatus = "pending" | "queued" | "running" | "succeeded" | "failed";

export const JOB_STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  pending: "受付済み",
  queued: "順番待ち",
  running: "処理中",
  succeeded: "完了",
  failed: "失敗",
};

/** まだ終わっていない（画面で進み具合を確認し続ける）か */
export function isJobActive(status: JobStatus): boolean {
  return status === "pending" || status === "queued" || status === "running";
}

/** 進み具合（0〜100 の整数）。件数が分からないうちは、完了なら100、それ以外は0 */
export function progressPercent(status: JobStatus, progress: number, total: number): number {
  if (status === "succeeded") return 100;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((progress * 100) / total)));
}
