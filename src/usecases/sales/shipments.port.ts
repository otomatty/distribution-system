import type { TaxCategory } from "../../domain/money";
import type { WriteMeta } from "../ports";

/** 発送（受注1件に有効なものは1件）。取り消した発送も履歴として残す */
export interface ShipmentRecord {
  readonly id: string;
  readonly salesOrderId: string;
  readonly deliveryNoteNumber: string;
  readonly shippedOn: string;
  /** 請求書に載せたら請求の区分が設定する（未請求なら null） */
  readonly invoiceId: string | null;
  readonly cancelled: boolean;
  readonly cancelReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
}

/** 納品書（発行済み帳票の索引の行） */
export interface DeliveryNoteRef {
  readonly shipmentId: string;
  readonly documentId: string;
  /** PDF の作成状況 */
  readonly status: "pending" | "ready" | "failed";
  readonly cancelled: boolean;
}

export interface ShipmentHistoryRow extends ShipmentRecord {
  readonly createdByName: string | null;
  readonly deliveryNote: DeliveryNoteRef | null;
}

/** 請求に使う、未請求の発送と明細（請求の区分が請求書を作るときに読む） */
export interface UnbilledShipment {
  readonly shipmentId: string;
  readonly shipmentVersion: number;
  readonly salesOrderId: string;
  readonly salesOrderNumber: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly shippedOn: string;
  readonly deliveryNoteNumber: string;
  readonly lines: readonly {
    /** 受注明細の ID（請求書の明細の発生元。返品伝票の明細も同じ ID を指す） */
    readonly salesOrderLineId: string;
    readonly itemId: string;
    readonly itemCode: string;
    readonly itemName: string;
    readonly salesUnitName: string;
    readonly quantity: number;
    readonly unitPriceCenti: number;
    readonly taxCategory: TaxCategory;
  }[];
  readonly charges: readonly {
    readonly salesChargeId: string;
    readonly description: string;
    readonly quantity: number;
    readonly unitAmount: number;
    readonly taxCategory: TaxCategory;
  }[];
}

export interface UnbilledShipmentFilter {
  readonly customerId?: string | undefined;
  readonly shippedFrom?: string | undefined;
  readonly shippedTo?: string | undefined;
}

export interface ShipmentStore {
  get(id: string): ShipmentRecord | undefined;
  /** 受注の発送の履歴（新しい順。取り消した発送も含む） */
  historyFor(salesOrderId: string): ShipmentHistoryRow[];
  insert(
    record: Omit<ShipmentRecord, "version" | "createdAt" | "createdBy" | "updatedAt">,
    meta: WriteMeta,
  ): void;
  /** 版番号が一致したときだけ取消済みにする。更新できたら true */
  cancel(id: string, expectedVersion: number, reason: string, meta: WriteMeta): boolean;
  /** 発送ごとの、取り消していない最新の納品書の ID（指定した発送の順。納品書のない発送は除く） */
  deliveryNoteIds(shipmentIds: readonly string[]): string[];
  /** 指定した受注の有効な発送 */
  activeForOrders(salesOrderIds: readonly string[]): ShipmentRecord[];
  /** 未請求（請求書なし・取り消していない）の発送。発送日・番号の順で limit 件まで */
  unbilled(filter: UnbilledShipmentFilter, limit: number): UnbilledShipment[];
}
