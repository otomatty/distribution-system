/** ダッシュボードの「仕入」と「支払」の欄（要件定義書 3.13）。件数は照会で数え、各項目は絞り込み済みの一覧に移る */
import { paths } from "../paths";
import { runQuery } from "../usecase";
import { yen } from "../views/format";
import type { DashboardItem, DashboardSection } from "./types";

export const purchasingSection: DashboardSection = {
  id: "purchasing",
  title: "仕入",
  roles: ["purchasing"],
  async load(c) {
    const [summary, reorder] = await Promise.all([
      runQuery(c, "purchasing.dashboard", {}),
      runQuery(c, "stock.reorderAlerts", {}),
    ]);
    const items: DashboardItem[] = [
      {
        label: "発注点割れの商品",
        count: reorder.length,
        href: paths.stock({ reorder: 1 }),
        attention: true,
      },
      {
        label: "作成中のままの発注",
        count: summary.draftOrders,
        href: paths.purchaseOrders({ status: "draft" }),
      },
      {
        label: "送付に失敗した発注書",
        count: summary.failedSends,
        href: paths.documents({
          documentType: "purchase_order",
          sendStatus: "failed",
          cancelled: "exclude",
        }),
        attention: true,
      },
      {
        label: "入荷予定日を過ぎた未入荷の発注",
        count: summary.overdueReceipts,
        href: paths.purchaseOrders({ overdue: 1 }),
        attention: true,
      },
    ];
    return items;
  },
};

export const payablesSection: DashboardSection = {
  id: "payables",
  title: "支払",
  roles: ["accounting"],
  async load(c) {
    const summary = await runQuery(c, "purchasing.dashboard", {});
    const week = summary.payablesThisWeek;
    const items: DashboardItem[] = [
      {
        label: "今週の支払予定",
        count: week.count,
        href: paths.payables({ dueFrom: week.from, dueTo: week.to }),
        note: `${week.from.slice(5).replace("-", "/")}〜${week.to.slice(5).replace("-", "/")} 残りの合計 ${yen(week.amount)}`,
      },
      {
        label: "支払予定日を過ぎた、支払の残っている仕入先請求書",
        count: summary.overduePayables.count,
        href: paths.payables({ overdue: 1 }),
        attention: true,
        note: `残りの合計 ${yen(summary.overduePayables.amount)}`,
      },
    ];
    return items;
  },
};
