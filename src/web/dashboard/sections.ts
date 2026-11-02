/**
 * ダッシュボードの「今日やること」の欄の一覧（要件定義書 3.13）。
 *
 * 欄を追加する手順：
 * 1. web/dashboard/<区分>.ts に DashboardSection（types.ts）を1つ書く。
 *    load では照会（runQuery）で件数を数え、項目ごとに絞り込み済みの一覧の URL を付ける
 * 2. 下の dashboardSections に1行で登録する（並べた順に表示する）
 *
 * load が失敗しても、ほかの欄は表示する（失敗した欄にはその旨を出す）。
 */
import type { Role } from "../../domain/roles";
import { platformSection } from "./platform";
import { payablesSection, purchasingSection } from "./purchasing";
import type { DashboardSection } from "./types";

/** 表示する順。仕入・受注出荷・経理の欄は各区分が追加する */
export const dashboardSections: readonly DashboardSection[] = [
  purchasingSection,
  payablesSection,
  platformSection,
];

/** 役割に合う欄。管理者はすべて */
export function sectionsFor(roles: readonly Role[]): readonly DashboardSection[] {
  if (roles.includes("admin")) return dashboardSections;
  return dashboardSections.filter((s) => s.roles.some((r) => roles.includes(r)));
}
