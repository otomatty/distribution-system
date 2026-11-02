import type { ReportsStores } from "../../../../usecases/reports/stores";
import type { Db } from "../../client";
import { reportStore } from "./monthly";

/** 集計（売上・仕入の月別の集計）のポートの実装をまとめる */
export function createReportsStores(db: Db): ReportsStores {
  return { reports: reportStore(db) };
}
