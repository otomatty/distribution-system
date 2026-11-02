/**
 * 返品伝票と返還請求書（要件定義書 3.11）。
 * - 返品伝票は発送後なら何回でも記録できる。明細ごとに返品数と、在庫に戻すか廃棄かを選ぶ
 *   （在庫に戻す明細は保管場所の在庫を「返品戻し」で増やす。廃棄は在庫を動かさない）
 * - 返品額は受注明細の単価 × 返品数（明細ごとに丸める）。未請求の返品伝票は次の請求書にマイナスの明細として載せる
 * - 返還請求書は、請求書に載せた（請求済みの）返品伝票について発行できる。税込1万円未満は発行を任意にする
 * - 返品伝票の取消は、請求書にも返還請求書にも載っていないときだけ（在庫は打ち消しの行で戻す）
 */
import { z } from "zod";

import {
  cancelSalesReturn,
  canRecordReturn,
  creditNoteIssuable,
  creditNoteObligation,
  returnableQuantity,
  returnLineAmount,
  returnSubtotal,
  validateReturnLines,
} from "../../domain/billing";
import { ratesOn, summarizeTax, type TaxSummary } from "../../domain/money";
import { err, ok, type Result } from "../../domain/result";
import {
  defineCommand,
  defineQuery,
  STALE_VERSION_MESSAGE,
  type QueryContext,
  type UsecaseContext,
} from "../core";
import type { ShipmentRecord } from "../sales/shipments.port";
import { businessDate, idSchema, optionalText, requiredText, version } from "../schemas";
import { postStock, reverseStock } from "../stock/ledger";
import type { SalesReturnRecord } from "./returns.port";
import { buildCreditNoteSnapshot } from "./snapshots";

function meta(ctx: UsecaseContext) {
  return { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId };
}

function fieldError(field: string, message: string): Result<never> {
  return err("validation", message, { fields: [{ field, message }] });
}

/** 受注の有効な発送（返品の元の取引） */
function activeShipment(
  ctx: Pick<QueryContext, "stores">,
  salesOrderId: string,
): ShipmentRecord | undefined {
  return ctx.stores.shipments.activeForOrders([salesOrderId])[0];
}

export const createSalesReturn = defineCommand({
  permission: "salesReturns.manage",
  input: z.object({
    salesOrderId: idSchema,
    returnedOn: businessDate,
    memo: optionalText(1000),
    lines: z
      .array(
        z.object({
          salesOrderLineId: idSchema,
          quantity: z
            .number({ error: "返品数は数字で入力してください" })
            .int("整数で入力してください"),
          restock: z.boolean(),
          locationId: z
            .string()
            .max(64)
            .nullable()
            .default(null)
            .transform((v) => (v ? v : null)),
        }),
      )
      .min(1, "返品する明細を入力してください")
      .max(300),
  }),
  run(ctx, input) {
    const order = ctx.stores.salesOrders.get(input.salesOrderId);
    if (!order) return err("not_found", "受注が見つかりません");
    const allowed = canRecordReturn(order.status);
    if (!allowed.ok) return allowed;
    const shipment = activeShipment(ctx, order.id);
    if (!shipment) return err("invalid_state", "発送済みの受注だけ返品伝票を記録できます");
    if (input.returnedOn < shipment.shippedOn)
      return fieldError("returnedOn", `返品日は発送日（${shipment.shippedOn}）以降にしてください`);
    if (input.returnedOn > ctx.clock.today())
      return fieldError("returnedOn", "今日より後の日付は入力できません");
    const returned = ctx.stores.salesReturns.returnedQuantities(order.id);
    const returnable = new Map(
      order.lines.map((l) => [l.id, { shipped: l.quantity, returned: returned.get(l.id) ?? 0 }]),
    );
    const checked = validateReturnLines(input.lines, returnable);
    if (!checked.ok) return checked;
    for (const l of checked.value) {
      if (l.locationId === null) continue;
      const location = ctx.stores.locations.get(l.locationId);
      if (!location || location.archived)
        return fieldError(`lines.${l.index}.locationId`, "在庫に戻す保管場所を選んでください");
    }
    const mode = ctx.stores.settings.getCompany().roundingMode;
    const id = ctx.ids.next();
    const number = ctx.sequences.next("salesReturn", input.returnedOn);
    // 返品する明細を受注の明細の順に並べる（検証済みの明細は必ず受注の明細のどれか）
    const requested = new Map(checked.value.map((l) => [l.salesOrderLineId, l]));
    const lines = order.lines.flatMap((line) => {
      const l = requested.get(line.id);
      return l
        ? [
            {
              id: ctx.ids.next(),
              salesOrderLineId: line.id,
              itemId: line.itemId,
              quantity: l.quantity,
              restock: l.restock,
              locationId: l.locationId,
              unitPriceCenti: line.unitPriceCenti,
              amount: returnLineAmount(line.unitPriceCenti, l.quantity, mode),
              taxCategory: line.taxCategory,
            },
          ]
        : [];
    });
    ctx.stores.salesReturns.insert(
      {
        id,
        number,
        salesOrderId: order.id,
        customerId: order.customerId,
        returnedOn: input.returnedOn,
        memo: input.memo,
      },
      lines,
      meta(ctx),
    );
    const restocked = lines.flatMap((l) =>
      l.locationId === null
        ? []
        : [
            {
              itemId: l.itemId,
              locationId: l.locationId,
              quantity: l.quantity,
              reason: "sales_return" as const,
            },
          ],
    );
    if (restocked.length > 0) {
      const posted = postStock(
        ctx,
        {
          sourceType: "sales_return",
          sourceId: id,
          businessDate: input.returnedOn,
          memo: `返品（${order.number}）`,
        },
        restocked,
      );
      if (!posted.ok) return posted;
    }
    ctx.audit.record({
      entityType: "sales_return",
      entityId: id,
      action: "create",
      after: { number, salesOrderId: order.id, returnedOn: input.returnedOn, lines },
    });
    return ok({ id, number, salesOrderId: order.id });
  },
});

/** 返品伝票の取消（請求書・返還請求書に載る前だけ）。在庫に戻した分は打ち消しの行で戻す */
export const cancelSalesReturnCommand = defineCommand({
  permission: "salesReturns.manage",
  input: z.object({ id: idSchema, version, reason: requiredText(500) }),
  run(ctx, { id, version: v, reason }) {
    const ret = ctx.stores.salesReturns.get(id);
    if (!ret) return err("not_found", "返品伝票が見つかりません");
    const next = cancelSalesReturn(ret);
    if (!next.ok) return next;
    if (!ctx.stores.salesReturns.cancel(id, v, reason, meta(ctx)))
      return err("conflict", STALE_VERSION_MESSAGE);
    const back = reverseStock(ctx, {
      sourceType: "sales_return",
      sourceId: id,
      businessDate: ctx.clock.today(),
      memo: `返品伝票の取消（${ret.number}）：${reason}`,
    });
    if (!back.ok) return back;
    ctx.audit.record({
      entityType: "sales_return",
      entityId: id,
      action: "cancel",
      before: { cancelled: false },
      after: { cancelled: true, reason },
    });
    return ok({ id, salesOrderId: ret.salesOrderId });
  },
});

interface CreditNotePlan {
  readonly summary: TaxSummary;
  readonly originalTransactionDate: string;
  readonly deliveryNoteNumber: string | null;
}

/**
 * 返還請求書の金額。税率は元の取引（発送）の日の税率で、税は返還請求書1枚ごとに税率ごとに1回丸める
 */
function creditNotePlan(
  ctx: Pick<QueryContext, "stores">,
  ret: SalesReturnRecord,
): Result<CreditNotePlan> {
  const shipment = activeShipment(ctx, ret.salesOrderId);
  const originalTransactionDate = shipment?.shippedOn ?? ret.returnedOn;
  const rates = ratesOn(ctx.stores.settings.listTaxRates(), originalTransactionDate);
  if (!rates)
    return err("invalid_state", "取引日の税率が設定されていません（管理者に連絡してください）");
  const mode = ctx.stores.settings.getCompany().roundingMode;
  return ok({
    summary: summarizeTax(ret.lines, rates, mode),
    originalTransactionDate,
    deliveryNoteNumber: shipment?.deliveryNoteNumber ?? null,
  });
}

/** 返還請求書の発行（請求済みの返品伝票）。返品伝票に番号を記録し、帳票を発行する */
export const issueCreditNote = defineCommand({
  permission: "invoices.manage",
  input: z.object({ salesReturnId: idSchema, version, issuedOn: businessDate }),
  run(ctx, { salesReturnId, version: v, issuedOn }) {
    const ret = ctx.stores.salesReturns.get(salesReturnId);
    if (!ret) return err("not_found", "返品伝票が見つかりません");
    const issuable = creditNoteIssuable(ret);
    if (!issuable.ok) return issuable;
    if (issuedOn < ret.returnedOn)
      return fieldError("issuedOn", `発行日は返品日（${ret.returnedOn}）以降にしてください`);
    if (issuedOn > ctx.clock.today())
      return fieldError("issuedOn", "発行日は今日より後にできません");
    const customer = ctx.stores.partners.get(ret.customerId);
    if (!customer) return err("not_found", "販売先が見つかりません");
    const plan = creditNotePlan(ctx, ret);
    if (!plan.ok) return plan;
    const number = ctx.sequences.next("creditNote", issuedOn);
    if (!ctx.stores.salesReturns.setCreditNote(ret.id, v, number, meta(ctx)))
      return err("conflict", STALE_VERSION_MESSAGE);
    const company = ctx.stores.settings.getCompany();
    const snapshot = buildCreditNoteSnapshot({
      number,
      issuedOn,
      returnNumber: ret.number,
      returnedOn: ret.returnedOn,
      originalTransactionDate: plan.value.originalTransactionDate,
      salesOrderNumber: ret.salesOrderNumber,
      deliveryNoteNumber: plan.value.deliveryNoteNumber,
      invoiceNumber: ret.invoiceNumber,
      company,
      customer,
      lines: ret.lines.map((l) => ({
        itemCode: l.itemCode,
        line: {
          description: l.itemName,
          quantity: l.quantity,
          unitName: l.unitName,
          unitPriceCenti: l.unitPriceCenti,
          amount: l.amount,
          taxCategory: l.taxCategory,
        },
      })),
      summary: plan.value.summary,
      roundingMode: company.roundingMode,
    });
    const documentId = ctx.documents.issue({
      documentType: "credit_note",
      number,
      entityId: ret.id,
      partnerId: ret.customerId,
      transactionDate: issuedOn,
      amount: plan.value.summary.total,
      snapshot,
    });
    ctx.audit.record({
      entityType: "sales_return",
      entityId: ret.id,
      action: "issue_credit_note",
      after: { creditNoteNumber: number, issuedOn, total: plan.value.summary.total, documentId },
    });
    return ok({ id: ret.id, number, documentId });
  },
});

// ---- 照会 -----------------------------------------------------------------------

export interface SalesReturnSummary extends SalesReturnRecord {
  /** 返品額の合計（税抜） */
  readonly subtotal: number;
  /** 取り消せるか（状態。権限は画面で判定する） */
  readonly cancellable: boolean;
}

export interface ReturnableOrderLine {
  readonly salesOrderLineId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitName: string;
  readonly unitPriceCenti: number;
  readonly shipped: number;
  readonly returned: number;
  readonly remaining: number;
}

export interface OrderReturns {
  readonly returns: readonly SalesReturnSummary[];
  /** 返品伝票を記録できるか（発送済みで、返品できる数が残っている） */
  readonly canRecord: boolean;
  readonly lines: readonly ReturnableOrderLine[];
  readonly shippedOn: string | null;
  /** 在庫に戻す保管場所の初期値（受注の出荷元） */
  readonly defaultLocationId: string | null;
  readonly salesOrderNumber: string;
  readonly customerName: string;
}

function summary(ret: SalesReturnRecord): SalesReturnSummary {
  return {
    ...ret,
    subtotal: returnSubtotal(ret.lines),
    cancellable: cancelSalesReturn(ret).ok,
  };
}

/** 受注の返品伝票（受注詳細の欄）と、明細ごとの返品できる数（返品伝票の登録画面） */
export const orderReturns = defineQuery({
  permission: "view",
  input: z.object({ salesOrderId: idSchema }),
  run(ctx, { salesOrderId }): OrderReturns | null {
    const order = ctx.stores.salesOrders.get(salesOrderId);
    if (!order) return null;
    const returned = ctx.stores.salesReturns.returnedQuantities(order.id);
    const shipment = order.status === "shipped" ? activeShipment(ctx, order.id) : undefined;
    const lines = order.lines.map((l): ReturnableOrderLine => {
      const r = { shipped: l.quantity, returned: returned.get(l.id) ?? 0 };
      return {
        salesOrderLineId: l.id,
        itemCode: l.itemCode,
        itemName: l.itemName,
        unitName: l.salesUnitName,
        unitPriceCenti: l.unitPriceCenti,
        ...r,
        remaining: returnableQuantity(r),
      };
    });
    return {
      returns: ctx.stores.salesReturns.forOrder(order.id).map(summary),
      canRecord:
        shipment !== undefined &&
        canRecordReturn(order.status).ok &&
        lines.some((l) => l.remaining > 0),
      lines,
      shippedOn: shipment?.shippedOn ?? null,
      defaultLocationId: order.locationId,
      salesOrderNumber: order.number,
      customerName: order.customerName,
    };
  },
});

export interface SalesReturnView {
  readonly ret: SalesReturnSummary;
  readonly cancelBlocker: string | null;
  readonly creditNote: {
    /** 発行できるか（状態。権限は画面で判定する） */
    readonly issuable: boolean;
    readonly blocker: string | null;
    /** 発行した場合の金額（税率ごとの合計と消費税額） */
    readonly preview: TaxSummary | null;
    /** 税込1万円以上は交付が必要、1万円未満は任意 */
    readonly obligation: "required" | "optional" | null;
    /** 発行した返還請求書の帳票 */
    readonly documentId: string | null;
  };
}

/** 返品伝票の詳細（明細、請求書、返還請求書） */
export const getSalesReturn = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): SalesReturnView | null {
    const ret = ctx.stores.salesReturns.get(id);
    if (!ret) return null;
    const cancellable = cancelSalesReturn(ret);
    const issuable = creditNoteIssuable(ret);
    const plan = creditNotePlan(ctx, ret);
    const total = plan.ok ? plan.value.summary.total : null;
    return {
      ret: summary(ret),
      cancelBlocker: ret.cancelled || cancellable.ok ? null : cancellable.error.message,
      creditNote: {
        issuable: issuable.ok && plan.ok,
        blocker: issuable.ok ? (plan.ok ? null : plan.error.message) : issuable.error.message,
        preview: plan.ok ? plan.value.summary : null,
        obligation: total === null ? null : creditNoteObligation(total),
        documentId:
          ret.creditNoteNumber === null
            ? null
            : (ctx.stores.documents.latestForEntities("credit_note", [ret.id])[0] ?? null),
      },
    };
  },
});
