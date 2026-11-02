import type { TaxCategory } from "../../domain/money";
import type { InvoiceStatus } from "../../domain/sales";
import type { WriteMeta } from "../ports";

export interface SalesReturnLineRecord {
  readonly id: string;
  readonly salesOrderLineId: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitName: string;
  /** 返品数（正の数） */
  readonly quantity: number;
  /** 在庫に戻した（false なら廃棄） */
  readonly restock: boolean;
  readonly locationId: string | null;
  readonly locationName: string | null;
  readonly unitPriceCenti: number;
  /** 返品額（税抜・円、正の数） */
  readonly amount: number;
  readonly taxCategory: TaxCategory;
}

/** 返品伝票 */
export interface SalesReturnRecord {
  readonly id: string;
  /** 返品伝票の番号（RT-2026-000001） */
  readonly number: string;
  readonly salesOrderId: string;
  readonly salesOrderNumber: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly returnedOn: string;
  /** 載せた請求書（未請求なら null） */
  readonly invoiceId: string | null;
  readonly invoiceNumber: string | null;
  readonly invoiceStatus: InvoiceStatus | null;
  /** 返還請求書の番号（CN-2026-000001） */
  readonly creditNoteNumber: string | null;
  /**
   * 返還請求書で精算した（請求書で差し引けない返品の）返品伝票なら、取り消していない返還額の入金。
   * 精算した返品伝票は未請求の返品伝票に含めない
   */
  readonly creditPaymentId: string | null;
  readonly cancelled: boolean;
  /** 取消の理由・日時（UTC）・操作者（取り消していなければ null） */
  readonly cancelReason: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledByName: string | null;
  readonly memo: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdByName: string | null;
  readonly lines: readonly SalesReturnLineRecord[];
}

export interface SalesReturnInsert {
  readonly id: string;
  readonly number: string;
  readonly salesOrderId: string;
  readonly customerId: string;
  readonly returnedOn: string;
  readonly memo: string | null;
}

export interface SalesReturnLineInsert {
  readonly id: string;
  readonly salesOrderLineId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly restock: boolean;
  readonly locationId: string | null;
  readonly unitPriceCenti: number;
  readonly amount: number;
  readonly taxCategory: TaxCategory;
}

export interface UnbilledReturnFilter {
  readonly customerId: string;
  /** この日までの返品だけ */
  readonly returnedTo?: string | undefined;
}

export interface SalesReturnStore {
  get(id: string): SalesReturnRecord | undefined;
  /** 指定した ID の返品伝票（見つかったものだけ。指定した順） */
  getMany(ids: readonly string[]): SalesReturnRecord[];
  /** 受注の返品伝票（新しい順。取り消したものも含む） */
  forOrder(salesOrderId: string): SalesReturnRecord[];
  /** 受注明細ごとの返品済みの数（取り消していない返品伝票の合計） */
  returnedQuantities(salesOrderId: string): Map<string, number>;
  /** 受注に取り消していない返品伝票があるか */
  hasActive(salesOrderId: string): boolean;
  insert(record: SalesReturnInsert, lines: readonly SalesReturnLineInsert[], meta: WriteMeta): void;
  /** 版番号が一致したときだけ取消済みにする（理由・日時・操作者を記録する）。更新できたら true */
  cancel(id: string, expectedVersion: number, reason: string, meta: WriteMeta): boolean;
  /** 版番号が一致したときだけ返還請求書の番号を記録する。更新できたら true */
  setCreditNote(id: string, expectedVersion: number, number: string, meta: WriteMeta): boolean;
  /** 版番号が一致したときだけ返還請求書の番号を消す（返還請求書の取消）。更新できたら true */
  clearCreditNote(id: string, expectedVersion: number, meta: WriteMeta): boolean;
  /**
   * 未請求（請求書に載せていない・取り消していない・返還請求書で精算していない）の返品伝票。返品日・番号の順。
   * 請求書を取り消した返品伝票は、返還請求書を発行していても未請求に戻る（次の請求書に載せる）
   */
  unbilled(filter: UnbilledReturnFilter, limit: number): SalesReturnRecord[];
}
