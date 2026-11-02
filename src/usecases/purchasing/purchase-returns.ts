/**
 * 仕入返品（要件定義書 3.6）：入荷後に見つかった不良品などを仕入先に返し、在庫から減らす。
 * 返品額は仕入先請求書の計算額から差し引く。数は販売単位で、受入数 × 入数 − これまでの返品 まで。
 * 取消は入荷の取消と同じ条件（支払（一部を含む）を記録した請求書に入っていなければ取り消せる。理由が必須）。
 */
import { z } from "zod";

import { cancelPurchaseReturn, recordPurchaseReturn } from "../../domain/purchasing";
import { err, ok } from "../../domain/result";
import { defineCommand, STALE_VERSION_MESSAGE } from "../core";
import {
  businessDate,
  idSchema,
  nonNegativeInt,
  optionalText,
  requiredText,
  version,
} from "../schemas";
import { postStock, reverseStock } from "../stock/ledger";
import { checkLocation, checkNotFuture } from "../stock/operations";
import { countBy, writeMeta } from "./common";
import { detachReturnFromInvoice, settleOrders } from "./supplier-invoices";

export const createPurchaseReturn = defineCommand({
  permission: "purchaseReturns.manage",
  input: z.object({
    purchaseOrderId: idSchema,
    returnedOn: businessDate,
    locationId: idSchema,
    memo: optionalText(500),
    lines: z
      .array(z.object({ lineId: idSchema, units: nonNegativeInt }))
      .min(1, "返品する商品がありません")
      .max(200),
  }),
  run(ctx, input) {
    const po = ctx.stores.purchaseOrders.get(input.purchaseOrderId);
    if (!po) return err("not_found", "発注が見つかりません");
    if (po.destinationKind !== "location")
      return err(
        "invalid_state",
        "メーカー直・その他の届け先の発注は在庫に入っていないため、仕入返品を記録できません",
      );
    const problem =
      checkNotFuture(ctx, input.returnedOn, "returnedOn") ??
      checkLocation(ctx, input.locationId, "locationId");
    if (problem) return problem;
    const accepted = countBy(ctx.stores.receipts.acceptedByLine(po.id), (a) => a.accepted);
    const returned = countBy(ctx.stores.purchaseReturns.returnedByLine(po.id), (r) => r.units);
    const mode = ctx.stores.settings.getCompany().roundingMode;
    const result = recordPurchaseReturn(
      po.status,
      po.lines.map((l) => ({
        ...l,
        acceptedQuantity: accepted(l.id),
        returnedUnits: returned(l.id),
      })),
      input.lines,
      mode,
    );
    if (!result.ok) return result;
    const lines = result.value.map((r) => ({
      id: ctx.ids.next(),
      purchaseOrderLineId: r.line.id,
      itemId: r.line.itemId,
      quantity: r.units,
      unitPriceCenti: r.line.unitPriceCenti,
      amount: r.amount,
      taxCategory: r.line.taxCategory,
    }));
    const id = ctx.ids.next();
    const number = ctx.sequences.next("purchaseReturn", input.returnedOn);
    const fields = {
      number,
      supplierId: po.supplierId,
      purchaseOrderId: po.id,
      returnedOn: input.returnedOn,
      locationId: input.locationId,
      memo: input.memo,
    };
    ctx.stores.purchaseReturns.insert(id, fields, lines, writeMeta(ctx));
    const posted = postStock(
      ctx,
      { sourceType: "purchase_return", sourceId: id, businessDate: input.returnedOn, memo: number },
      lines.map((l) => ({
        itemId: l.itemId,
        locationId: input.locationId,
        quantity: -l.quantity,
        reason: "purchase_return",
      })),
    );
    if (!posted.ok) return posted;
    ctx.audit.record({
      entityType: "purchase_return",
      entityId: id,
      action: "create",
      after: { ...fields, lines },
    });
    return ok({ id, number });
  },
});

/**
 * 仕入返品の取消（入荷の取消と同じ条件。domain の cancelPurchaseReturn）。
 * - 在庫は打ち消しの行で戻し（台帳への追記と集計表の更新は同じトランザクション）、返品できる数も戻る
 * - 未払いの請求書から差し引いていれば請求書から外し、計算額と差額を計算し直す（差額の理由がなければ取消のためと記録する）
 * - 発注の状態は settledOrderStatus で決め直す（仕入返品は入荷済みの数・残りの数を変えないので、通常は変わらない）
 */
export const cancelPurchaseReturnCommand = defineCommand({
  permission: "purchaseReturns.manage",
  input: z.object({ id: idSchema, version, reason: requiredText(500) }),
  run(ctx, { id, version: v, reason }) {
    const ret = ctx.stores.purchaseReturns.get(id);
    if (!ret) return err("not_found", "仕入返品が見つかりません");
    const allowed = cancelPurchaseReturn(ret.cancelled, ret.supplierInvoiceStatus, reason);
    if (!allowed.ok) return allowed;
    const meta = writeMeta(ctx);
    if (!ctx.stores.purchaseReturns.markCancelled(id, v, reason, meta))
      return err("conflict", STALE_VERSION_MESSAGE);
    const back = reverseStock(ctx, {
      sourceType: "purchase_return",
      sourceId: id,
      businessDate: ctx.clock.today(),
      memo: `${ret.number} の取消：${reason}`,
    });
    if (!back.ok) return back;
    if (ret.supplierInvoiceId) {
      const detached = detachReturnFromInvoice(ctx, ret.supplierInvoiceId, ret);
      if (!detached.ok) return detached;
    }
    settleOrders(ctx, [ret.purchaseOrderId], "cancel_purchase_return", { purchaseReturnId: id });
    ctx.audit.record({
      entityType: "purchase_return",
      entityId: id,
      action: "cancel",
      before: { cancelled: false, supplierInvoiceId: ret.supplierInvoiceId },
      after: { cancelled: true, reason, reversedEntryIds: back.value.entryIds },
    });
    return ok({ id, purchaseOrderId: ret.purchaseOrderId });
  },
});
