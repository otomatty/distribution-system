import { enc, withQuery, type Query } from "./query";

/** 在庫の画面 */
export const stockPaths = {
  stock: (query?: Query) => withQuery("/stock", query),
  /** 在庫一覧の CSV（POST。在庫一覧と同じ絞り込みの条件をフォームで送る） */
  stockCsv: () => "/stock/csv",
  /** 在庫明細（商品ごとの台帳） */
  stockItem: (itemId: string, query?: Query) => withQuery(`/stock/${enc(itemId)}`, query),
  stockOperations: (query?: Query) => withQuery("/stock/operations", query),
  stockOperationNew: (query?: Query) => withQuery("/stock/operations/new", query),
  /** 在庫操作の明細の行（商品選択ダイアログから追加する。部分 HTML） */
  stockOperationLines: () => "/stock/operations/lines",
  stockOperation: (id: string) => `/stock/operations/${enc(id)}`,
  stocktaking: (query?: Query) => withQuery("/stock/stocktaking", query),
  /** 棚卸の入力表の行（商品選択ダイアログから追加する。部分 HTML） */
  stocktakingLines: () => "/stock/stocktaking/lines",
};
