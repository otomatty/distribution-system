/** ダッシュボードの「今日やること」の仕入と支払の件数（要件定義書 3.13） */
import { z } from "zod";

import { addDays, weekRange } from "../../domain/dates";
import { defineQuery } from "../core";

export interface PurchasingDashboard {
  readonly today: string;
  /** 作成中のままの発注 */
  readonly draftOrders: number;
  /** 最新の送付が失敗した発注書（取消済みを除く） */
  readonly failedSends: number;
  /** 納品希望日を過ぎた未入荷の発注（発注済み） */
  readonly overdueReceipts: number;
  /** 今週（月曜〜日曜）が支払予定日の未払いの仕入先請求書 */
  readonly payablesThisWeek: {
    readonly count: number;
    readonly amount: number;
    readonly from: string;
    readonly to: string;
  };
  /** 支払予定日を過ぎた未払いの仕入先請求書（予定日は昨日まで） */
  readonly overduePayables: {
    readonly count: number;
    readonly amount: number;
    readonly to: string;
  };
}

export const purchasingDashboard = defineQuery({
  permission: "view",
  input: z.object({}),
  run(ctx): PurchasingDashboard {
    const today = ctx.clock.today();
    const week = weekRange(today);
    const yesterday = addDays(today, -1);
    return {
      today,
      draftOrders: ctx.stores.purchaseOrders.count({ status: "draft" }),
      failedSends: ctx.stores.documents.count({
        documentType: "purchase_order",
        sendStatus: "failed",
        cancelled: "exclude",
      }),
      overdueReceipts: ctx.stores.purchaseOrders.count({
        status: "ordered",
        deliveryBefore: today,
      }),
      payablesThisWeek: {
        ...ctx.stores.supplierInvoices.totals({
          status: "unpaid",
          dueFrom: week.from,
          dueTo: week.to,
        }),
        ...week,
      },
      overduePayables: {
        ...ctx.stores.supplierInvoices.totals({ status: "unpaid", dueTo: yesterday }),
        to: yesterday,
      },
    };
  },
});
