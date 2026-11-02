/**
 * 入荷（要件定義書 3.6、4章 遷移表）。
 * - 分納：複数回に分けて記録できる。全数がそろうか「残りは打ち切り」で入荷済みになる
 * - 明細ごとに受入数と返品数（その場で返したもの）を分ける。在庫に入るのは「受入数 × 入数」
 * - 保管場所は発注の納入先から決まる。メーカー直・その他の届け先は「納品済み」の確認だけで在庫を動かさない
 * - 取消は、支払済みの請求書に含まれていなければできる（在庫は打ち消しの行で戻す）
 */
import { z } from "zod";

import { lineAmount } from "../../domain/money";
import {
  cancelReceipt,
  receiptCancelBlockedByReturns,
  recordReceipt,
  remainingQuantity,
  revertReceipt,
  stockQuantity,
} from "../../domain/purchasing";
import { err, ok } from "../../domain/result";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE } from "../core";
import {
  businessDate,
  idSchema,
  nonNegativeInt,
  optionalText,
  requiredText,
  version,
} from "../schemas";
import { postStock, reverseStock } from "../stock/ledger";
import { checkNotFuture } from "../stock/operations";
import { countBy, writeMeta } from "./common";
import type { ReceiptLineFields, ScheduledLine } from "./receipts.port";
import { detachReceiptFromInvoice } from "./supplier-invoices";

export const recordPurchaseReceipt = defineCommand({
  permission: "receipts.manage",
  input: z.object({
    purchaseOrderId: idSchema,
    version,
    receivedOn: businessDate,
    memo: optionalText(500),
    lines: z
      .array(
        z.object({
          lineId: idSchema,
          accepted: nonNegativeInt,
          returned: nonNegativeInt,
          closeRemaining: z.boolean().default(false),
        }),
      )
      .min(1, "明細がありません")
      .max(200),
  }),
  run(ctx, input) {
    const po = ctx.stores.purchaseOrders.get(input.purchaseOrderId);
    if (!po) return err("not_found", "発注が見つかりません");
    const future = checkNotFuture(ctx, input.receivedOn, "receivedOn");
    if (future) return future;
    const recorded = recordReceipt(po.status, po.lines, input.lines);
    if (!recorded.ok) return recorded;
    const mode = ctx.stores.settings.getCompany().roundingMode;
    const receiptLines: (ReceiptLineFields & { id: string })[] = recorded.value.changes.map(
      ({ line, accepted, returned, closedNow }) => ({
        id: ctx.ids.next(),
        purchaseOrderLineId: line.id,
        itemId: line.itemId,
        accepted,
        returned,
        closedRemaining: closedNow,
        unitPriceCenti: line.unitPriceCenti,
        unitsPerPurchaseUnit: line.unitsPerPurchaseUnit,
        taxCategory: line.taxCategory,
        amount: lineAmount(line.unitPriceCenti, accepted, mode),
      }),
    );
    const meta = writeMeta(ctx);
    if (
      !ctx.stores.purchaseOrders.update(
        po.id,
        input.version,
        { status: recorded.value.status },
        meta,
      )
    )
      return err("conflict", STALE_VERSION_MESSAGE);
    ctx.stores.purchaseOrders.saveLineProgress(recorded.value.lines);
    const id = ctx.ids.next();
    const number = ctx.sequences.next("receipt", input.receivedOn);
    // 在庫に入れるのは納入先が保管場所の発注だけ（メーカー直・その他の届け先は「納品済み」の記録だけ）
    const locationId = po.destinationKind === "location" ? po.destinationLocationId : null;
    ctx.stores.receipts.insert(
      id,
      {
        number,
        purchaseOrderId: po.id,
        receivedOn: input.receivedOn,
        locationId,
        memo: input.memo,
      },
      receiptLines,
      meta,
    );
    if (locationId) {
      const posted = postStock(
        ctx,
        { sourceType: "receipt", sourceId: id, businessDate: input.receivedOn, memo: number },
        receiptLines.map((l) => ({
          itemId: l.itemId,
          locationId,
          quantity: stockQuantity(l.accepted, l.unitsPerPurchaseUnit),
          reason: "receipt",
        })),
      );
      if (!posted.ok) return posted;
    }
    ctx.audit.record({
      entityType: "receipt",
      entityId: id,
      action: "create",
      after: {
        number,
        purchaseOrderId: po.id,
        receivedOn: input.receivedOn,
        locationId,
        lines: receiptLines,
      },
    });
    ctx.audit.record({
      entityType: "purchase_order",
      entityId: po.id,
      action: "receive",
      before: { status: po.status },
      after: { status: recorded.value.status, receiptId: id },
    });
    return ok({ id, number, status: recorded.value.status });
  },
});

/** 入荷の取消。在庫を打ち消しの行で戻し、発注を発注済みに戻す */
export const cancelPurchaseReceipt = defineCommand({
  permission: "receipts.manage",
  input: z.object({ id: idSchema, version, reason: requiredText(500) }),
  run(ctx, { id, version: v, reason }) {
    const receipt = ctx.stores.receipts.get(id);
    if (!receipt) return err("not_found", "入荷が見つかりません");
    if (receipt.cancelled) return err("invalid_state", "この入荷はすでに取り消されています");
    const po = ctx.stores.purchaseOrders.get(receipt.purchaseOrderId);
    if (!po) return err("not_found", "発注が見つかりません");
    const next = cancelReceipt(po.status, receipt.supplierInvoiceStatus === "paid");
    if (!next.ok) return next;
    const reverted = revertReceipt(po.lines, receipt.lines);
    if (!reverted.ok) return reverted;
    const accepted = countBy(ctx.stores.receipts.acceptedByLine(po.id), (a) => a.accepted);
    const returned = countBy(ctx.stores.purchaseReturns.returnedByLine(po.id), (r) => r.units);
    const blocked = receiptCancelBlockedByReturns(
      receipt.lines.map((l) => ({
        acceptedAfter: accepted(l.purchaseOrderLineId) - l.accepted,
        unitsPerPurchaseUnit: l.unitsPerPurchaseUnit,
        returnedUnits: returned(l.purchaseOrderLineId),
      })),
    );
    if (!blocked.ok) return blocked;
    const meta = writeMeta(ctx);
    if (!ctx.stores.receipts.markCancelled(id, v, reason, meta))
      return err("conflict", STALE_VERSION_MESSAGE);
    // 戻した結果マイナスになる（入荷した商品をもう出荷した）なら insufficient_stock で全体を取り消す
    const back = reverseStock(ctx, {
      sourceType: "receipt",
      sourceId: id,
      businessDate: ctx.clock.today(),
      memo: `${receipt.number} の取消：${reason}`,
    });
    if (!back.ok) return back;
    ctx.stores.purchaseOrders.setStatus(po.id, next.value, meta);
    ctx.stores.purchaseOrders.saveLineProgress(reverted.value);
    if (receipt.supplierInvoiceId) {
      const detached = detachReceiptFromInvoice(ctx, receipt.supplierInvoiceId, receipt);
      if (!detached.ok) return detached;
    }
    ctx.audit.record({
      entityType: "receipt",
      entityId: id,
      action: "cancel",
      before: { cancelled: false, supplierInvoiceId: receipt.supplierInvoiceId },
      after: { cancelled: true, reason },
    });
    ctx.audit.record({
      entityType: "purchase_order",
      entityId: po.id,
      action: "cancel_receipt",
      before: { status: po.status },
      after: { status: next.value, receiptId: id },
    });
    return ok({ id, purchaseOrderId: po.id });
  },
});

export interface ScheduledOrder {
  readonly purchaseOrderId: string;
  readonly purchaseOrderNumber: string;
  readonly supplierName: string;
  readonly orderedOn: string;
  readonly deliveryRequestedOn: string | null;
  /** 納品希望日を過ぎているか */
  readonly overdue: boolean;
  readonly destinationName: string | null;
  readonly lines: readonly {
    readonly lineId: string;
    readonly itemCode: string;
    readonly itemName: string;
    readonly purchaseUnitName: string;
    readonly remaining: number;
  }[];
}

export interface ScheduleGroup {
  /** 保管場所ごとのまとまり。メーカー直・その他の届け先は locationId が null のまとまりにする */
  readonly locationId: string | null;
  readonly title: string;
  readonly orders: readonly ScheduledOrder[];
}

/**
 * 入荷予定一覧（要件定義書 3.6）：発注済みで未入荷の明細を、保管場所ごとに納品希望日の順で表示する。
 * メーカー直・その他の届け先の発注は、最後に別のまとまりで表示する（在庫には入らない）。
 */
export const receivingSchedule = defineQuery({
  permission: "view",
  input: z.object({
    locationId: z.string().max(64).optional(),
    overdue: z.boolean().default(false),
  }),
  run(ctx, { locationId, overdue }): ScheduleGroup[] {
    const today = ctx.clock.today();
    const rows = ctx.stores.receipts.scheduled({ locationId: locationId || undefined });
    const orders = new Map<
      string,
      { first: ScheduledLine; lines: ScheduledOrder["lines"][number][] }
    >();
    for (const r of rows) {
      const remaining = remainingQuantity({
        id: r.lineId,
        quantity: r.quantity,
        receivedQuantity: r.receivedQuantity,
        closed: r.closed,
      });
      const entry = orders.get(r.purchaseOrderId) ?? { first: r, lines: [] };
      entry.lines.push({
        lineId: r.lineId,
        itemCode: r.itemCode,
        itemName: r.itemName,
        purchaseUnitName: r.purchaseUnitName,
        remaining,
      });
      orders.set(r.purchaseOrderId, entry);
    }
    const groups = new Map<string, ScheduleGroup & { orders: ScheduledOrder[] }>();
    const direct: ScheduledOrder[] = [];
    for (const { first, lines } of orders.values()) {
      const isOverdue = first.deliveryRequestedOn !== null && first.deliveryRequestedOn < today;
      if (overdue && !isOverdue) continue;
      const order: ScheduledOrder = {
        purchaseOrderId: first.purchaseOrderId,
        purchaseOrderNumber: first.purchaseOrderNumber,
        supplierName: first.supplierName,
        orderedOn: first.orderedOn,
        deliveryRequestedOn: first.deliveryRequestedOn,
        overdue: isOverdue,
        destinationName: first.destinationName,
        lines,
      };
      if (first.destinationKind !== "location" || !first.destinationLocationId) {
        direct.push(order);
        continue;
      }
      const key = first.destinationLocationId;
      const group = groups.get(key) ?? {
        locationId: key,
        title: first.destinationName,
        orders: [],
      };
      group.orders.push(order);
      groups.set(key, group);
    }
    const out: ScheduleGroup[] = [...groups.values()];
    if (direct.length > 0)
      out.push({ locationId: null, title: "メーカー直・その他の届け先", orders: direct });
    return out;
  },
});
