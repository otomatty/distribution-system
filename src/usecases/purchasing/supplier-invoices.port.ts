import type { AmountLine } from "../../domain/money";
import type { SupplierInvoiceStatus } from "../../domain/purchasing";
import type { WriteMeta } from "../ports";
import type { Page } from "../schemas";

/** 仕入先請求書（要件定義書 3.7）。金額は税込・円 */
export interface SupplierInvoiceFields {
  readonly supplierId: string;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: string;
  /** 請求額（請求書に書かれた額） */
  readonly invoicedAmount: number;
  /** 送料（請求書に書かれた額） */
  readonly shippingFee: number;
  /** システムの計算額（受入数 × 単価 − 仕入返品 に税を加え、送料を足したもの） */
  readonly computedAmount: number;
  /** 請求額 − 計算額 */
  readonly difference: number;
  readonly differenceReason: string | null;
  readonly paymentDueOn: string | null;
  readonly memo: string | null;
}

export interface SupplierPaymentRecord {
  readonly id: string;
  readonly paidOn: string;
  readonly amount: number;
  readonly memo: string | null;
  readonly cancelled: boolean;
  readonly cancelReason: string | null;
  readonly createdAt: string;
  readonly createdByName: string | null;
}

export interface SupplierInvoiceRecord extends SupplierInvoiceFields {
  readonly id: string;
  readonly status: SupplierInvoiceStatus;
  readonly cancelReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdByName: string | null;
  readonly supplierName: string;
  /** 取り消していない支払（支払済みのとき） */
  readonly payment: SupplierPaymentRecord | null;
}

/** 請求の対象にする入荷（明細の金額を税区分ごとにまとめたもの） */
export interface InvoiceReceiptRow {
  readonly id: string;
  readonly number: string;
  readonly purchaseOrderId: string;
  readonly purchaseOrderNumber: string;
  readonly receivedOn: string;
  /** 税区分ごとの受入数 × 単価の合計（税抜・円） */
  readonly amounts: readonly AmountLine[];
}

/** 請求から差し引く仕入返品 */
export interface InvoiceReturnRow {
  readonly id: string;
  readonly number: string;
  readonly purchaseOrderId: string | null;
  readonly purchaseOrderNumber: string | null;
  readonly returnedOn: string;
  /** 税区分ごとの返品額の合計（税抜・円、正の数） */
  readonly amounts: readonly AmountLine[];
}

export interface SupplierInvoiceFilter {
  readonly status?: SupplierInvoiceStatus | undefined;
  readonly supplierId?: string | undefined;
  /** 請求日の範囲 */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** 支払予定日の範囲 */
  readonly dueFrom?: string | undefined;
  readonly dueTo?: string | undefined;
  /** 請求書番号・仕入先名の部分一致 */
  readonly q?: string | undefined;
}

export interface MonthlyPayable {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly month: string;
  readonly invoiced: number;
  readonly paid: number;
}

export interface SupplierInvoiceStore {
  insert(id: string, fields: SupplierInvoiceFields, meta: WriteMeta): void;
  get(id: string): SupplierInvoiceRecord | undefined;
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<
      SupplierInvoiceFields & { status: SupplierInvoiceStatus; cancelReason: string | null }
    >,
    meta: WriteMeta,
  ): boolean;
  /** 支払予定日の順（未定は後ろ）、同じなら請求日の順 */
  list(filter: SupplierInvoiceFilter, page: number, pageSize: number): Page<SupplierInvoiceRecord>;
  /** 条件に合う請求書の件数と請求額の合計 */
  totals(filter: SupplierInvoiceFilter): { count: number; amount: number };
  /** まだ請求書に結びついていない、取り消していない入荷（受入のあるもの）と仕入返品 */
  candidates(supplierId: string): { receipts: InvoiceReceiptRow[]; returns: InvoiceReturnRow[] };
  linkedReceipts(invoiceId: string): InvoiceReceiptRow[];
  linkedReturns(invoiceId: string): InvoiceReturnRow[];
  /** 入荷・仕入返品を請求書に結びつける（invoiceId が null なら外す） */
  setReceiptInvoice(receiptIds: readonly string[], invoiceId: string | null): void;
  setReturnInvoice(returnIds: readonly string[], invoiceId: string | null): void;
  /** 支払の記録（取消を含む、新しい順） */
  payments(invoiceId: string): SupplierPaymentRecord[];
  insertPayment(
    id: string,
    invoiceId: string,
    payment: { paidOn: string; amount: number; memo: string | null },
    meta: WriteMeta,
  ): void;
  cancelPayment(paymentId: string, reason: string, meta: WriteMeta): void;
  /** 請求書に結びついた入荷の発注 */
  orderIds(invoiceId: string): string[];
  /** 発注の入荷（取り消していない、受入のあるもの）のうち、支払済みの請求書に入っていないものの件数 */
  unpaidReceiptCount(orderId: string): number;
  /** 発注の入荷を含む請求書（取消を除く） */
  invoicesForOrder(
    orderId: string,
  ): { id: string; invoiceNumber: string | null; status: SupplierInvoiceStatus }[];
  /** 月ごとの請求額（請求日の月）と支払額（支払日の月）。取消を除く */
  monthly(from: string, to: string, supplierId?: string): MonthlyPayable[];
  /** from より前の、仕入先ごとの請求額の合計 − 支払額の合計 */
  openingBalances(
    before: string,
    supplierId?: string,
  ): { supplierId: string; supplierName: string; balance: number }[];
}
