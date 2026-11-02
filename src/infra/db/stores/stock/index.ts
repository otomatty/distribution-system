import type { StockStores } from "../../../../usecases/stock/stores";
import type { Db } from "../../client";

/** 在庫（台帳・在庫操作・棚卸）のポートの実装をまとめる */
export function createStockStores(db: Db): StockStores {
  void db;
  return {};
}
