import type { ReportStore } from "./monthly.port";

/** 集計（売上・仕入の月別の集計）のポート。実装は infra/db/stores/reports */
export interface ReportsStores {
  readonly reports: ReportStore;
}
