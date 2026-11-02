/**
 * ユースケースが使う入出力のポート。実装は infra/db/stores にある。
 * ポートは機能の区分ごとに usecases/<区分>/stores.ts に定義する。
 */
import type { BillingStores } from "./billing/stores";
import type { MastersStores } from "./masters/stores";
import type { PlatformStores } from "./platform/stores";
import type { PurchasingStores } from "./purchasing/stores";
import type { ReportsStores } from "./reports/stores";
import type { SalesStores } from "./sales/stores";
import type { StockStores } from "./stock/stores";

/** 書き込み時に記録する日時と操作者（社員 ID） */
export interface WriteMeta {
  readonly at: string;
  readonly by: string;
}

export type Stores = MastersStores &
  StockStores &
  PurchasingStores &
  SalesStores &
  BillingStores &
  PlatformStores &
  ReportsStores;
