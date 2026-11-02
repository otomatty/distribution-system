import type { Page } from "../schemas";

/** 操作履歴の検索条件（どれも省略でき、指定したものをすべて満たす行を返す） */
export interface AuditLogFilter {
  /** この時刻（UTC の ISO 文字列）以降 */
  readonly from?: string | undefined;
  /** この時刻（UTC の ISO 文字列）より前 */
  readonly until?: string | undefined;
  /** 操作した社員の ID（システムの処理は "system"） */
  readonly employeeId?: string | undefined;
  readonly entityType?: string | undefined;
  /** 対象の ID のどれか */
  readonly entityIds?: readonly string[] | undefined;
  readonly action?: string | undefined;
}

export interface AuditLogRecord {
  readonly id: string;
  /** 操作した日時（UTC） */
  readonly occurredAt: string;
  readonly employeeId: string;
  /** 社員の氏名（社員でない操作者は null） */
  readonly employeeName: string | null;
  /** ユースケースの名前（items.update など） */
  readonly command: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  /** 変更前後の値（JSON）。記録していなければ null */
  readonly beforeJson: string | null;
  readonly afterJson: string | null;
}

export interface AuditLogStore {
  /** 新しい順 */
  search(filter: AuditLogFilter, page: number, pageSize: number): Page<AuditLogRecord>;
  /**
   * 画面や帳票に出す番号（PO-2026-000123、納品書の番号、仕入先の請求書番号など）と商品コードから、
   * その伝票・商品・帳票の ID を引く（完全一致）
   */
  idsForNumber(number: string): string[];
}
