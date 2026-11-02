import { withQuery, type Query } from "./query";

/** 請求・入金・販売先廃棄の画面 */
export const billingPaths = {
  invoices: (query?: Query) => withQuery("/invoices", query),
  customerReceipts: (query?: Query) => withQuery("/receipts", query),
  receivables: (query?: Query) => withQuery("/receivables", query),
  disposals: (query?: Query) => withQuery("/disposals", query),
};
