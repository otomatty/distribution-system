/** ダッシュボードの「受注・出荷」の欄の件数（要件定義書 3.13） */
import { z } from "zod";

import { addDays } from "../../domain/dates";
import { defineQuery } from "../core";
import type { SalesDashboardCounts } from "./orders.port";

export interface SalesDashboard extends SalesDashboardCounts {
  /** 件数を数えた業務日（一覧の絞り込みの URL に使う） */
  readonly today: string;
  /** 出荷予定日を過ぎた受注の絞り込みに使う日（昨日） */
  readonly overdueShipTo: string;
}

/**
 * 今日までの出荷予定（保管場所別の件数。発送リストと同じく出荷予定日を過ぎた未発送の受注を含み、そのうちの遅れの件数も数える）、
 * 出荷可能数が足りない受注、出荷予定日を過ぎた未発送の受注。
 * 今日の入荷予定は仕入の区分の照会で数える（受注の区分では数えない）。
 */
export const salesDashboard = defineQuery({
  permission: "view",
  input: z.object({}),
  run(ctx): SalesDashboard {
    const today = ctx.clock.today();
    return {
      today,
      overdueShipTo: addDays(today, -1),
      ...ctx.stores.salesOrders.dashboard(today),
    };
  },
});
