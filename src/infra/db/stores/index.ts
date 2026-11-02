import type { Stores } from "../../../usecases/ports";
import type { Db } from "../client";
import { createBillingStores } from "./billing";
import { createMastersStores } from "./masters";
import { createPlatformStores } from "./platform";
import { createPurchasingStores } from "./purchasing";
import { createSalesStores } from "./sales";
import { createStockStores } from "./stock";

/** ポートの実装をまとめる。機能の区分ごとの実装は各フォルダの index.ts に追加する */
export function createStores(db: Db): Stores {
  return {
    ...createMastersStores(db),
    ...createStockStores(db),
    ...createPurchasingStores(db),
    ...createSalesStores(db),
    ...createBillingStores(db),
    ...createPlatformStores(db),
  };
}
