import { enc, withQuery, type Query } from "./query";

/** 仕入の画面 */
export const purchasingPaths = {
  purchaseOrders: (query?: Query) => withQuery("/purchase-orders", query),
  /** 発注一覧の CSV（POST。絞り込みの条件はフォームで送る） */
  purchaseOrdersCsv: () => "/purchase-orders/csv",
  purchaseOrderNew: (query?: Query) => withQuery("/purchase-orders/new", query),
  /** 商品選択ダイアログから明細の行を追加する（部分 HTML） */
  purchaseOrderLines: () => "/purchase-orders/lines",
  /** 明細の金額と合計の計算し直し・行を外す（部分 HTML） */
  purchaseOrderRecalc: () => "/purchase-orders/lines/recalc",
  purchaseOrder: (id: string, query?: Query) => withQuery(`/purchase-orders/${enc(id)}`, query),
  purchaseOrderEdit: (id: string) => `/purchase-orders/${enc(id)}/edit`,
  purchaseOrderConfirm: (id: string) => `/purchase-orders/${enc(id)}/confirm`,
  purchaseOrderCancel: (id: string) => `/purchase-orders/${enc(id)}/cancel`,
  purchaseOrderMemo: (id: string) => `/purchase-orders/${enc(id)}/memo`,
  purchaseReturnNew: (orderId: string) => `/purchase-orders/${enc(orderId)}/returns/new`,

  receiving: (query?: Query) => withQuery("/receiving", query),
  /** 入荷確認（タブレット） */
  receivingOrder: (orderId: string, query?: Query) =>
    withQuery(`/receiving/${enc(orderId)}`, query),
  /** 入荷の取消（POST） */
  receiptCancel: (receiptId: string) => `/receiving/receipts/${enc(receiptId)}/cancel`,

  supplierInvoices: (query?: Query) => withQuery("/supplier-invoices", query),
  supplierInvoicesCsv: () => "/supplier-invoices/csv",
  supplierInvoiceNew: (query?: Query) => withQuery("/supplier-invoices/new", query),
  /** 登録画面の計算額と差額（部分 HTML） */
  supplierInvoicePreview: () => "/supplier-invoices/preview",
  supplierInvoice: (id: string, query?: Query) => withQuery(`/supplier-invoices/${enc(id)}`, query),
  supplierInvoicePay: (id: string) => `/supplier-invoices/${enc(id)}/pay`,
  supplierInvoiceCancelPayment: (id: string) => `/supplier-invoices/${enc(id)}/cancel-payment`,
  supplierInvoiceCancel: (id: string) => `/supplier-invoices/${enc(id)}/cancel`,

  payables: (query?: Query) => withQuery("/payables", query),
  payablesCsv: () => "/payables/csv",
  payablesBulkPay: () => "/payables/pay",
  payableBalances: (query?: Query) => withQuery("/payables/balances", query),
  payableBalancesCsv: (query?: Query) => withQuery("/payables/balances.csv", query),
};
