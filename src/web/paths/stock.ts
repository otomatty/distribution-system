import { withQuery, type Query } from "./query";

/** 在庫の画面 */
export const stockPaths = {
  stock: (query?: Query) => withQuery("/stock", query),
  stockOperationNew: () => "/stock/operations/new",
};
