import { enc, withQuery, type Query } from "./query";

/** 請求・入金・販売先廃棄の画面 */
export const billingPaths = {
  invoices: (query?: Query) => withQuery("/invoices", query),
  /** 請求書一覧の CSV（POST。一覧と同じ絞り込みの条件） */
  invoicesCsv: () => "/invoices/csv",
  /** 未請求の発送の一覧と、発送ごとの請求書の発行（shipmentId を付けると発行の画面） */
  invoiceNew: (query?: Query) => withQuery("/invoices/new", query),
  /** 発送ごとの請求書の見積もり（部分 HTML。載せる返品伝票を選び直したとき） */
  invoiceNewPreview: () => "/invoices/new/preview",
  invoiceClosing: (query?: Query) => withQuery("/invoices/closing", query),
  /** 締め処理の確認（部分 HTML） */
  invoiceClosingConfirm: () => "/invoices/closing/confirm",
  /** 締め処理の実行（POST） */
  invoiceClosingRun: () => "/invoices/closing/run",
  /** 請求書の一括 PDF（POST。請求書の ID） */
  invoicesBulkPdf: () => "/invoices/bulk-pdf",
  invoice: (id: string, query?: Query) => withQuery(`/invoices/${enc(id)}`, query),
  invoiceCancel: (id: string) => `/invoices/${enc(id)}/cancel`,
  invoiceReissue: (id: string) => `/invoices/${enc(id)}/reissue`,

  /** 返品伝票の登録（受注の ID を付ける） */
  salesReturnNew: (orderId: string) => withQuery("/sales-returns/new", { orderId }),
  salesReturn: (id: string, query?: Query) => withQuery(`/sales-returns/${enc(id)}`, query),
  salesReturnCancel: (id: string) => `/sales-returns/${enc(id)}/cancel`,
  /** 返品伝票の詳細の「返還請求書」の欄（受注詳細から移る） */
  salesReturnCreditNote: (id: string) => `/sales-returns/${enc(id)}#credit-note`,
  creditNoteIssue: (returnId: string) => `/sales-returns/${enc(returnId)}/credit-note`,
  /** 請求書で差し引けない返品の返還請求書の発行（POST） */
  creditNoteIssueUnbilled: (returnId: string) =>
    `/sales-returns/${enc(returnId)}/credit-note/unbilled`,
  /** 請求書で差し引けない返品の返還請求書の取消（POST） */
  creditNoteCancelUnbilled: (returnId: string) =>
    `/sales-returns/${enc(returnId)}/credit-note/cancel`,

  customerReceipts: (query?: Query) => withQuery("/receipts", query),
  customerReceiptsCsv: () => "/receipts/csv",
  customerReceiptNew: (query?: Query) => withQuery("/receipts/new", query),
  /** 入金の登録画面：販売先の消込の対象の請求書（部分 HTML） */
  customerReceiptInvoices: (query?: Query) => withQuery("/receipts/new/invoices", query),
  customerReceipt: (id: string, query?: Query) => withQuery(`/receipts/${enc(id)}`, query),
  customerReceiptAllocate: (id: string) => `/receipts/${enc(id)}/allocate`,
  customerReceiptCancel: (id: string) => `/receipts/${enc(id)}/cancel`,
  /** 返還請求書の返還額の残りを返金済みにする（POST） */
  customerReceiptRefund: (id: string) => `/receipts/${enc(id)}/refund`,
  allocationCancel: (id: string) => `/receipts/allocations/${enc(id)}/cancel`,
  refundCancel: (id: string) => `/receipts/refunds/${enc(id)}/cancel`,

  receivables: (query?: Query) => withQuery("/receivables", query),
  receivablesCsv: () => "/receivables/csv",
  /** 入金予定（支払期限の順） */
  receiptSchedule: (query?: Query) => withQuery("/receivables/schedule", query),
  receiptScheduleCsv: () => "/receivables/schedule/csv",

  disposals: (query?: Query) => withQuery("/disposals", query),
  disposalsCsv: () => "/disposals/csv",
  disposalNew: (query?: Query) => withQuery("/disposals/new", query),
  /** 廃棄伝票の登録画面：販売先に出荷した商品の行（部分 HTML） */
  disposalShippedItems: () => "/disposals/new/shipped",
  /** 廃棄伝票の登録画面：商品選択ダイアログから行を足す（部分 HTML） */
  disposalLines: () => "/disposals/new/lines",
  disposal: (id: string, query?: Query) => withQuery(`/disposals/${enc(id)}`, query),
  /** 廃棄伝票の取消（POST） */
  disposalCancel: (id: string) => `/disposals/${enc(id)}/cancel`,
  disposalRates: (query?: Query) => withQuery("/disposals/rates", query),
  disposalRatesCsv: () => "/disposals/rates/csv",
};
