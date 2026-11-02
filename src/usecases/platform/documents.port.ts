import type { DocumentType, RenderStatus, SendMethod, SendStatus } from "../../domain/documents";
import type { WriteMeta } from "../ports";
import type { Page } from "../schemas";

/** 帳票の検索条件（電子帳簿保存法：取引年月日・金額の範囲指定と、取引先・種類・番号の組み合わせ） */
export interface DocumentFilter {
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  readonly amountMin?: number | undefined;
  readonly amountMax?: number | undefined;
  readonly partnerId?: string | undefined;
  readonly documentType?: DocumentType | undefined;
  /** 番号の部分一致 */
  readonly number?: string | undefined;
  /** 取消済みを含めるか。未指定なら両方 */
  readonly cancelled?: "exclude" | "only" | undefined;
  readonly renderStatus?: RenderStatus | undefined;
  /** 最新の送付の結果。unsent は一度も送付していないもの */
  readonly sendStatus?: "failed" | "sent" | "unsent" | undefined;
  /** 指定した種類だけに絞る（送付できる種類だけを数えるときなど） */
  readonly documentTypes?: readonly DocumentType[] | undefined;
}

export interface DocumentSummary {
  readonly id: string;
  readonly documentType: DocumentType;
  readonly number: string;
  readonly entityId: string;
  readonly partnerId: string;
  readonly partnerName: string | null;
  readonly transactionDate: string;
  readonly amount: number;
  readonly status: RenderStatus;
  readonly cancelled: boolean;
  readonly createdAt: string;
  /** 最新の送付 */
  readonly lastSendStatus: SendStatus | null;
  readonly lastSendMethod: SendMethod | null;
}

export interface DocumentRecord extends DocumentSummary {
  readonly r2Key: string | null;
  readonly createdByName: string | null;
  readonly updatedAt: string;
  readonly version: number;
}

export interface DocumentSendRecord {
  readonly id: string;
  readonly documentId: string;
  readonly method: SendMethod;
  readonly recipient: string | null;
  readonly status: SendStatus;
  readonly error: string | null;
  readonly sentAt: string | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdByName: string | null;
  /** その帳票の最新の送付か */
  readonly isLatest: boolean;
}

export interface DocumentStore {
  search(filter: DocumentFilter, page: number, pageSize: number): Page<DocumentSummary>;
  count(filter: DocumentFilter): number;
  get(id: string): DocumentRecord | undefined;
  /** 存在する帳票の ID（指定した順） */
  existingIds(ids: readonly string[]): string[];
  /** 元の伝票ごとの、取消されていない最新の帳票の ID（指定した順） */
  latestForEntities(type: DocumentType, entityIds: readonly string[]): string[];
  /** 送付履歴（新しい順） */
  sends(documentId: string): DocumentSendRecord[];
  getSend(id: string): DocumentSendRecord | undefined;
  /** PDF 化に失敗したときの理由（処理の記録から） */
  renderError(documentId: string): string | null;
  /** PDF を作り直すため、作成待ちに戻す（作成済みのものは変えない） */
  resetRender(id: string, meta: WriteMeta): void;
}
