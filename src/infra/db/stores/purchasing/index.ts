import type { PurchasingStores } from "../../../../usecases/purchasing/stores";
import type { Db } from "../../client";

/** 仕入（発注・入荷・仕入返品・仕入先請求書・支払）のポートの実装をまとめる */
export function createPurchasingStores(db: Db): PurchasingStores {
  void db;
  return {};
}
