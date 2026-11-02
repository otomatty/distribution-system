import type { BillingStores } from "../../../../usecases/billing/stores";
import type { Db } from "../../client";

/** 請求と入金（請求書・締め処理・返品・返還請求書・入金と消込・売掛・販売先廃棄・集計）のポートの実装をまとめる */
export function createBillingStores(db: Db): BillingStores {
  void db;
  return {};
}
