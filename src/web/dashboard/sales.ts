/**
 * ダッシュボードの「受注・出荷」の欄（要件定義書 3.13）：今日までの出荷予定（保管場所別。出荷予定日を過ぎた未発送の受注を含み、
 * その件数を「うち遅れ」に出す）、出荷可能数が足りない受注、
 * 出荷予定日を過ぎた未発送の受注、今日の入荷予定（倉庫で受け取る。件数は仕入の区分の照会で数える）。
 */
import { paths } from "../paths";
import { runQuery } from "../usecase";
import type { DashboardItem, DashboardSection } from "./types";

export const salesSection: DashboardSection = {
  id: "sales",
  title: "受注・出荷",
  roles: ["sales"],
  async load(c) {
    const [d, receipts] = await Promise.all([
      runQuery(c, "sales.dashboard", {}),
      runQuery(c, "receipts.dueToday", {}),
    ]);
    // 発送リストと同じく、出荷予定日を過ぎた（遅れの）未発送の受注も含めて数える
    const items: DashboardItem[] = d.shipPlanned.map((p) => ({
      label: `今日までの出荷予定（${p.locationName}）`,
      count: p.count,
      href:
        p.locationId === null
          ? paths.salesOrders({ status: "received", locationId: "maker", shipTo: d.today })
          : paths.shipping({ date: d.today, locationId: p.locationId }),
      ...(p.overdue > 0 ? { note: `うち遅れ ${p.overdue} 件` } : {}),
    }));
    if (items.length === 0) {
      items.push({
        label: "今日までの出荷予定",
        count: 0,
        href: paths.salesOrders({ status: "received", shipTo: d.today }),
      });
    }
    items.push(
      {
        label: "出荷可能数が足りない受注",
        count: d.shortage,
        href: paths.salesOrders({ status: "received", shortage: 1 }),
        attention: true,
      },
      {
        label: "出荷予定日を過ぎた未発送の受注",
        count: d.overdue,
        href: paths.salesOrders({ status: "received", shipTo: d.overdueShipTo }),
        attention: true,
      },
      {
        label: "今日の入荷予定",
        count: receipts.count,
        href: paths.receiving({ on: receipts.today }),
      },
    );
    return items;
  },
};
