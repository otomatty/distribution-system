import type { TaxCategory } from "../../domain/money";
import type { SupplierInvoiceStatus } from "../../domain/purchasing";
import type { WriteMeta } from "../ports";

/** 仕入返品（入荷後に見つかった不良品など）。在庫から減らし、仕入先請求書の計算額から差し引く */
export interface PurchaseReturnFields {
  readonly number: string;
  readonly supplierId: string;
  readonly purchaseOrderId: string;
  readonly returnedOn: string;
  /** 在庫を減らした保管場所 */
  readonly locationId: string;
  readonly memo: string | null;
}

export interface PurchaseReturnLineFields {
  readonly purchaseOrderLineId: string;
  readonly itemId: string;
  /** 返品した数（販売単位） */
  readonly quantity: number;
  /** 発注明細の単価の写し（仕入単位あたり、税抜、centi-yen） */
  readonly unitPriceCenti: number;
  /** 返品額（税抜・円、正の数） */
  readonly amount: number;
  readonly taxCategory: TaxCategory;
}

export interface PurchaseReturnRecord extends PurchaseReturnFields {
  readonly id: string;
  readonly supplierInvoiceId: string | null;
  /** 差し引いた仕入先請求書の状態（請求書に入っていなければ null） */
  readonly supplierInvoiceStatus: SupplierInvoiceStatus | null;
  readonly cancelled: boolean;
  /** 取消の理由・日時（UTC）・操作者（取り消していなければ null） */
  readonly cancelReason: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledByName: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdByName: string | null;
  readonly locationName: string;
  readonly lines: readonly (PurchaseReturnLineFields & {
    readonly id: string;
    readonly itemCode: string;
    readonly itemName: string;
    readonly salesUnitName: string;
  })[];
}

export interface PurchaseReturnStore {
  insert(
    id: string,
    fields: PurchaseReturnFields,
    lines: readonly (PurchaseReturnLineFields & { id: string })[],
    meta: WriteMeta,
  ): void;
  get(id: string): PurchaseReturnRecord | undefined;
  /** 発注の仕入返品（取り消したものを含む、返品日・記録の順） */
  listByOrder(orderId: string): PurchaseReturnRecord[];
  /** 版番号が一致し、まだ取り消していないときだけ取消にする（理由・日時・操作者を記録する） */
  markCancelled(id: string, expectedVersion: number, reason: string, meta: WriteMeta): boolean;
  /** 発注明細ごとの、取り消していない仕入返品の数の合計（販売単位） */
  returnedByLine(orderId: string): { lineId: string; units: number }[];
}
