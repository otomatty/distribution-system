/** ダッシュボードの「今日やること」の仕入と支払の件数（要件定義書 3.13） */
import { z } from "zod";

import { addDays, weekRange } from "../../domain/dates";
import { OPEN_SUPPLIER_INVOICE_STATUSES } from "../../domain/purchasing";
import { defineQuery } from "../core";

export interface PurchasingDashboard {
  readonly today: string;
  /** 作成中のままの発注 */
  readonly draftOrders: number;
  /** 最新の送付が失敗した発注書（取消済みを除く） */
  readonly failedSends: number;
  /** 納品希望日を過ぎた未入荷の発注（発注済み） */
  readonly overdueReceipts: number;
  /**
   * 今週（月曜〜日曜）が支払予定日の、支払の残っている（未払い・一部支払の）仕入先請求書。
   * amount は残りの額（請求額 − 支払済みの額）の合計
   */
  readonly payablesThisWeek: {
    readonly count: number;
    readonly amount: number;
    readonly from: string;
    readonly to: string;
  };
  /** 支払予定日を過ぎた、支払の残っている仕入先請求書（予定日は昨日まで）。amount は残りの額の合計 */
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
    const open = (filter: { dueFrom?: string; dueTo: string }) => {
      const t = ctx.stores.supplierInvoices.totals({
        statuses: OPEN_SUPPLIER_INVOICE_STATUSES,
        ...filter,
      });
      return { count: t.count, amount: t.remaining };
    };
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
      payablesThisWeek: { ...open({ dueFrom: week.from, dueTo: week.to }), ...week },
      overduePayables: { ...open({ dueTo: yesterday }), to: yesterday },
    };
  },
});

export interface ReceiptsDueToday {
  readonly today: string;
  /** 納品希望日が今日で、まだ入荷が終わっていない発注（発注済み）の件数 */
  readonly count: number;
}

/**
 * ダッシュボードの「受注・出荷」の欄の「今日の入荷予定」（要件定義書 3.13）。倉庫で受け取る人が見る。
 * 入荷予定一覧（receipts.schedule）を今日の納品希望日で絞り込んだときの発注の件数と同じ
 */
export const receiptsDueToday = defineQuery({
  permission: "view",
  input: z.object({}),
  run(ctx): ReceiptsDueToday {
    const today = ctx.clock.today();
    const lines = ctx.stores.receipts.scheduled({ deliveryOn: today });
    return { today, count: new Set(lines.map((l) => l.purchaseOrderId)).size };
  },
});
