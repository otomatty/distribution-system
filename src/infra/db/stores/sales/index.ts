import type { SalesStores } from "../../../../usecases/sales/stores";
import type { Db } from "../../client";

/** 販売（受注・引当・分割・発送・納品書）のポートの実装をまとめる */
export function createSalesStores(db: Db): SalesStores {
  void db;
  return {};
}
