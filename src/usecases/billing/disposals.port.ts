import type { DisposalReason } from "../../domain/billing";
import type { WriteMeta } from "../ports";
import type { Page } from "../schemas";

export interface DisposalLineRecord {
  readonly id: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitName: string;
  readonly quantity: number;
  readonly reason: DisposalReason | null;
}

/** 販売先廃棄の伝票（記録と分析だけ。請求・入金・自社の在庫には影響しない） */
export interface DisposalRecord {
  readonly id: string;
  /** 廃棄伝票の番号（DS-2026-000001） */
  readonly number: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly disposedOn: string;
  /** 先方の担当者 */
  readonly contactName: string | null;
  readonly memo: string | null;
  /** 取り消したか（取り消した伝票は廃棄率の集計に含めない）と、その理由・日時（UTC）・操作者 */
  readonly cancelled: boolean;
  readonly cancelReason: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledByName: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdByName: string | null;
  readonly lines: readonly DisposalLineRecord[];
}

export interface DisposalListRow {
  readonly id: string;
  readonly number: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly disposedOn: string;
  readonly contactName: string | null;
  readonly lineCount: number;
  readonly totalQuantity: number;
  readonly cancelled: boolean;
  readonly cancelReason: string | null;
  readonly createdAt: string;
}

/** 取り消した伝票の扱い：すべて（undefined）・取り消していないものだけ・取り消したものだけ */
export type DisposalCancelledFilter = "exclude" | "only";

export interface DisposalFilter {
  readonly customerId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cancelled?: DisposalCancelledFilter | undefined;
}

/** 販売先に出荷したことのある商品（廃棄伝票の商品の候補で先に出す） */
export interface ShippedItem {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitName: string;
  /** 最後に出荷した日 */
  readonly lastShippedOn: string;
}

/** 廃棄率の集計の元（期間内の、販売先 × 商品ごとの廃棄数と出荷数） */
export interface DisposalRateSource {
  readonly customerId: string;
  readonly customerName: string;
  readonly customerKana: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitName: string;
  readonly disposed: number;
  readonly shipped: number;
}

export interface DisposalStore {
  get(id: string): DisposalRecord | undefined;
  /** 廃棄日の新しい順 */
  list(filter: DisposalFilter, page: number, pageSize: number): Page<DisposalListRow>;
  insert(
    record: {
      readonly id: string;
      readonly number: string;
      readonly customerId: string;
      readonly disposedOn: string;
      readonly contactName: string | null;
      readonly memo: string | null;
    },
    lines: readonly {
      readonly id: string;
      readonly itemId: string;
      readonly quantity: number;
      readonly reason: DisposalReason | null;
    }[],
    meta: WriteMeta,
  ): void;
  /** 版番号が一致し、まだ取り消していないときだけ取消にする（理由・日時・操作者を記録する）。更新できたら true */
  markCancelled(id: string, expectedVersion: number, reason: string, meta: WriteMeta): boolean;
  /** 販売先に出荷した（取り消していない発送の）商品。最後に出荷した日の新しい順 */
  shippedItems(customerId: string, limit: number): ShippedItem[];
  /**
   * 期間内の、販売先 × 商品ごとの廃棄数（取り消していない廃棄伝票の廃棄日が期間内）と出荷数（取り消していない発送の
   * 発送日が期間内）。どちらかが 1 以上の組み合わせだけ。販売先の読み仮名・商品コードの順
   */
  rateSources(filter: {
    readonly from: string;
    readonly to: string;
    readonly customerId?: string | undefined;
    readonly itemId?: string | undefined;
  }): DisposalRateSource[];
}
