import { withQuery, type Query } from "./query";

/** 受注・発送の画面 */
export const salesPaths = {
  salesOrders: (query?: Query) => withQuery("/sales-orders", query),
  shipping: (query?: Query) => withQuery("/shipping", query),
};
