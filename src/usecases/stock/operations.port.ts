import type { AdjustmentReason, StockOperationKind } from "../../domain/stock";
import type { WriteMeta } from "../ports";
import type { Page } from "../schemas";

/** 在庫操作伝票（調整・移動・店舗払い出し・棚卸） */
export interface StockOperationFields {
  readonly number: string;
  readonly kind: StockOperationKind;
  readonly operationDate: string;
  /** 調整・払い出し・棚卸の保管場所。移動では移動元 */
  readonly locationId: string;
  /** 移動先（移動のときだけ） */
  readonly toLocationId: string | null;
  /** 払い出し先店舗（店舗払い出しのときだけ） */
  readonly storeId: string | null;
  /** 調整の理由（調整のときだけ） */
  readonly adjustmentReason: AdjustmentReason | null;
  readonly memo: string | null;
}

export interface StockOperationLine {
  readonly itemId: string;
  /** 調整は符号つき、移動・払い出しは正の数、棚卸は実際に数えた数 */
  readonly quantity: number;
}

export interface StockOperationSummary extends StockOperationFields {
  readonly id: string;
  readonly locationName: string;
  readonly toLocationName: string | null;
  readonly storeName: string | null;
  readonly lineCount: number;
  readonly createdAt: string;
  readonly createdByName: string | null;
}

export interface StockOperationDetail extends StockOperationSummary {
  readonly lines: readonly (StockOperationLine & {
    readonly itemCode: string;
    readonly itemName: string;
    readonly salesUnitName: string;
  })[];
}

export interface StockOperationFilter {
  readonly kind?: StockOperationKind | undefined;
  /** 移動元・移動先のどちらかがこの保管場所 */
  readonly locationId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface StockOperationStore {
  insert(
    id: string,
    fields: StockOperationFields,
    lines: readonly (StockOperationLine & { id: string })[],
    meta: WriteMeta,
  ): void;
  get(id: string): StockOperationDetail | undefined;
  /** 新しい順 */
  list(filter: StockOperationFilter, page: number, pageSize: number): Page<StockOperationSummary>;
}
