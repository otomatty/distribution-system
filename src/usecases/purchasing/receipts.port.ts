import type { TaxCategory } from "../../domain/money";
import type { DestinationKind, SupplierInvoiceStatus } from "../../domain/purchasing";
import type { WriteMeta } from "../ports";

/** 入荷1件（分納なら発注1件に複数）。明細は発注明細の単価・入数・税区分を写し、金額を持つ */
export interface ReceiptFields {
  readonly number: string;
  readonly purchaseOrderId: string;
  readonly receivedOn: string;
  /** 在庫に入れた保管場所（メーカー直・その他の届け先は null） */
  readonly locationId: string | null;
  readonly memo: string | null;
}

export interface ReceiptLineFields {
  readonly purchaseOrderLineId: string;
  readonly itemId: string;
  /** 受入数（仕入単位） */
  readonly accepted: number;
  /** その場で返した数（仕入単位） */
  readonly returned: number;
  /** この入荷で残りを打ち切ったか */
  readonly closedRemaining: boolean;
  readonly unitPriceCenti: number;
  readonly unitsPerPurchaseUnit: number;
  readonly taxCategory: TaxCategory;
  /** 受入数 × 単価（税抜・円、明細ごとに丸めた値） */
  readonly amount: number;
}

export interface ReceiptLineRecord extends ReceiptLineFields {
  readonly id: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly purchaseUnitName: string;
}

export interface ReceiptRecord extends ReceiptFields {
  readonly id: string;
  readonly supplierInvoiceId: string | null;
  readonly supplierInvoiceStatus: SupplierInvoiceStatus | null;
  readonly cancelled: boolean;
  readonly cancelReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdByName: string | null;
  readonly locationName: string | null;
  readonly lines: readonly ReceiptLineRecord[];
}

/** 入荷予定一覧の1行（発注済みで残りのある明細） */
export interface ScheduledLine {
  readonly purchaseOrderId: string;
  readonly purchaseOrderNumber: string;
  readonly supplierName: string;
  readonly orderedOn: string;
  readonly deliveryRequestedOn: string | null;
  readonly destinationKind: DestinationKind;
  readonly destinationLocationId: string | null;
  /** 保管場所名・販売先名（その他の届け先は住所の先頭） */
  readonly destinationName: string;
  readonly lineId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly purchaseUnitName: string;
  readonly quantity: number;
  readonly receivedQuantity: number;
  readonly closed: boolean;
}

export interface ReceiptStore {
  insert(
    id: string,
    fields: ReceiptFields,
    lines: readonly (ReceiptLineFields & { id: string })[],
    meta: WriteMeta,
  ): void;
  get(id: string): ReceiptRecord | undefined;
  /** 発注の入荷（取り消したものを含む、入荷日・記録の順） */
  listByOrder(orderId: string): ReceiptRecord[];
  /** 版番号が一致したときだけ取消にする */
  markCancelled(id: string, expectedVersion: number, reason: string, meta: WriteMeta): boolean;
  /** 取り消していない入荷の件数 */
  activeCount(orderId: string): number;
  /** 発注明細ごとの、取り消していない入荷の受入数の合計（仕入単位） */
  acceptedByLine(orderId: string): { lineId: string; accepted: number }[];
  /** 発注済みで残りのある明細（入荷予定一覧）。納品希望日の順。deliveryOn は納品希望日がその日のものだけ */
  scheduled(filter: {
    locationId?: string | undefined;
    deliveryOn?: string | undefined;
  }): ScheduledLine[];
}
