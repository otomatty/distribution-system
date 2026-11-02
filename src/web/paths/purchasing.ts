import { withQuery, type Query } from "./query";

/** 仕入の画面 */
export const purchasingPaths = {
  purchaseOrders: (query?: Query) => withQuery("/purchase-orders", query),
  receiving: (query?: Query) => withQuery("/receiving", query),
  supplierInvoices: (query?: Query) => withQuery("/supplier-invoices", query),
  payables: (query?: Query) => withQuery("/payables", query),
};
