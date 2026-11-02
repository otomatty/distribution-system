/**
 * ダッシュボードの「請求・入金」の欄（要件定義書 3.13 経理）：締め処理待ちの販売先、支払期限を過ぎた請求書、
 * 送付に失敗した請求書。今週の支払予定は仕入の欄で扱う。
 */
import { paths } from "../paths";
import { runQuery } from "../usecase";
import type { DashboardSection } from "./types";

export const billingSection: DashboardSection = {
  id: "billing",
  title: "請求・入金",
  roles: ["accounting"],
  async load(c) {
    const d = await runQuery(c, "billing.dashboard", {});
    return [
      {
        label: "締め処理待ちの販売先",
        count: d.closingWaiting,
        href: paths.invoiceClosing(),
        attention: true,
      },
      {
        label: "支払期限を過ぎた請求書",
        count: d.overdueInvoices,
        href: paths.invoices({ overdue: 1 }),
        attention: true,
      },
      {
        label: "送付に失敗した請求書",
        count: d.failedSends,
        href: paths.invoices({ sendFailed: 1 }),
        attention: true,
      },
    ];
  },
};
