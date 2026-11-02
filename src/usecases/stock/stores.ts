import type { StockStore } from "./ledger.port";
import type { StockOperationStore } from "./operations.port";

/** 在庫（台帳・在庫操作・棚卸）のポート。実装は infra/db/stores/stock */
export interface StockStores {
  /** 在庫台帳と集計表。書き込みは usecases/stock/ledger.ts の関数を通す */
  readonly stock: StockStore;
  readonly stockOperations: StockOperationStore;
}
