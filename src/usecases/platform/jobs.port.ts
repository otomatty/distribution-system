import type { JobStatus, JobType } from "../../domain/jobs";

export interface JobView {
  readonly id: string;
  readonly type: JobType;
  readonly status: JobStatus;
  readonly progress: number;
  readonly total: number;
  /** 結果のファイル（R2 の保存先とダウンロードするときの名前） */
  readonly resultKey: string | null;
  readonly resultName: string | null;
  readonly error: string | null;
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface JobFilter {
  /** 依頼した社員。未指定ならすべて */
  readonly createdBy?: string | undefined;
  readonly types: readonly JobType[];
  readonly status?: "active" | "failed" | undefined;
}

export interface JobStore {
  /** 新しい順 */
  list(filter: JobFilter, limit: number): JobView[];
  get(id: string): JobView | undefined;
  /** まだ終わっていない処理と、since 以降に失敗した処理の件数 */
  counts(filter: JobFilter, since: string): { readonly active: number; readonly failed: number };
  /** その種類の最新の処理（status を指定すればその状態のもの） */
  latest(type: JobType, status?: JobStatus): JobView | undefined;
}
