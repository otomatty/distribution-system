import { withQuery, type Query } from "./query";

/** 集計（売上・仕入の月別の集計）の画面 */
export const reportsPaths = {
  reports: (query?: Query) => withQuery("/reports", query),
  reportsCsv: () => "/reports/csv",
};
