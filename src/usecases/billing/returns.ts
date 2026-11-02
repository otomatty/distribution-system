/**
 * 返品伝票と返還請求書（要件定義書 3.11）。
 * - 返品伝票は発送後なら何回でも記録できる。明細ごとに返品数と、在庫に戻すか廃棄かを選ぶ
 *   （在庫に戻す明細は保管場所の在庫を「返品戻し」で増やす。廃棄は在庫を動かさない）
 * - 返品額は受注明細の単価 × 返品数（明細ごとに丸める）。未請求の返品伝票は次の請求書にマイナスの明細として載せる
 * - 返還請求書は、請求書に載せた（請求済みの）返品伝票について発行できる（帳票だけ）。税込1万円未満は発行を任意にする
 * - 請求書で差し引けない返品（どの請求書にも載っていない返品伝票）も返還請求書を発行できる。発行すると返品伝票は
 *   精算済みになり（以後の請求書・締め処理に載せない）、返還額（税込）を方法「相殺」の入金（返還額）として記録する。
 *   返還額は未消込の入金として売掛残高を減らし、後の請求書に消し込むか、返金済みにする（payments.ts）
 * - その返還請求書の取消は、返還額を請求書に充てていない・返金していないときだけ。返還額の入金を取り消し、
 *   帳票を取消済みにして、返品伝票は未請求に戻る
 * - 返品伝票の取消は、請求書にも返還請求書にも載っていないときだけ（在庫は打ち消しの行で戻す）
 */
import { z } from "zod";

import {
  cancelSalesReturn,
  cancelUnbilledCreditNote,
  canRecordReturn,
  creditAmount,
  creditNoteIssuable,
  creditNoteObligation,
  creditRemaining,
  returnableQuantity,
  returnLineAmount,
  returnSubtotal,
  unbilledCreditNoteIssuable,
  validateReturnLines,
  type CreditUsage,
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
import type { PartnerRecord } from "../masters/partners.port";
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
    if (!ctx.stores.salesReturns.cancel(id, v, meta(ctx)))
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

/** 返品伝票の返還請求書の帳票を発行する（請求済みの返品・請求書で差し引けない返品で共通） */
function issueCreditNoteDocument(
  ctx: UsecaseContext,
  a: {
    readonly ret: SalesReturnRecord;
    readonly customer: PartnerRecord;
    readonly number: string;
    readonly issuedOn: string;
    readonly plan: CreditNotePlan;
  },
): string {
  const company = ctx.stores.settings.getCompany();
  const snapshot = buildCreditNoteSnapshot({
    number: a.number,
    issuedOn: a.issuedOn,
    returnNumber: a.ret.number,
    returnedOn: a.ret.returnedOn,
    originalTransactionDate: a.plan.originalTransactionDate,
    salesOrderNumber: a.ret.salesOrderNumber,
    deliveryNoteNumber: a.plan.deliveryNoteNumber,
    invoiceNumber: a.ret.invoiceNumber,
    company,
    customer: a.customer,
    lines: a.ret.lines.map((l) => ({
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
    summary: a.plan.summary,
    roundingMode: company.roundingMode,
  });
  return ctx.documents.issue({
    documentType: "credit_note",
    number: a.number,
    entityId: a.ret.id,
    partnerId: a.ret.customerId,
    transactionDate: a.issuedOn,
    amount: a.plan.summary.total,
    snapshot,
  });
}

/** 発行日は返品日より前にも、今日より後にもできない */
function checkIssuedOn(
  ctx: UsecaseContext,
  ret: SalesReturnRecord,
  issuedOn: string,
): Result<never> | null {
  if (issuedOn < ret.returnedOn)
    return fieldError("issuedOn", `発行日は返品日（${ret.returnedOn}）以降にしてください`);
  if (issuedOn > ctx.clock.today()) return fieldError("issuedOn", "発行日は今日より後にできません");
  return null;
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
    const dateError = checkIssuedOn(ctx, ret, issuedOn);
    if (dateError) return dateError;
    const customer = ctx.stores.partners.get(ret.customerId);
    if (!customer) return err("not_found", "販売先が見つかりません");
    const plan = creditNotePlan(ctx, ret);
    if (!plan.ok) return plan;
    const number = ctx.sequences.next("creditNote", issuedOn);
    if (!ctx.stores.salesReturns.setCreditNote(ret.id, v, number, meta(ctx)))
      return err("conflict", STALE_VERSION_MESSAGE);
    const documentId = issueCreditNoteDocument(ctx, {
      ret,
      customer,
      number,
      issuedOn,
      plan: plan.value,
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

/**
 * 請求書で差し引けない返品（どの請求書にも載っていない返品伝票）の返還請求書の発行。
 * 返品伝票に番号を記録して精算済みにし（以後の請求書・締め処理に載せない）、帳票を発行し、
 * 返還額（税込）を方法「相殺」の入金（返還額。入金日は発行日）として記録する。返還額は未消込の入金として売掛残高を減らす
 */
export const issueUnbilledCreditNote = defineCommand({
  permission: "invoices.manage",
  input: z.object({ salesReturnId: idSchema, version, issuedOn: businessDate }),
  run(ctx, { salesReturnId, version: v, issuedOn }) {
    const ret = ctx.stores.salesReturns.get(salesReturnId);
    if (!ret) return err("not_found", "返品伝票が見つかりません");
    const issuable = unbilledCreditNoteIssuable(ret);
    if (!issuable.ok) return issuable;
    const dateError = checkIssuedOn(ctx, ret, issuedOn);
    if (dateError) return dateError;
    const customer = ctx.stores.partners.get(ret.customerId);
    if (!customer) return err("not_found", "販売先が見つかりません");
    const plan = creditNotePlan(ctx, ret);
    if (!plan.ok) return plan;
    const amount = creditAmount(plan.value.summary.total);
    if (!amount.ok) return amount;
    const number = ctx.sequences.next("creditNote", issuedOn);
    const m = meta(ctx);
    if (!ctx.stores.salesReturns.setCreditNote(ret.id, v, number, m))
      return err("conflict", STALE_VERSION_MESSAGE);
    const paymentId = ctx.ids.next();
    ctx.stores.customerPayments.insert(
      {
        id: paymentId,
        customerId: ret.customerId,
        receivedOn: issuedOn,
        amount: amount.value,
        method: "offset",
        memo: `返還請求書 ${number}（返品伝票 ${ret.number}）の返還額`,
        salesReturnId: ret.id,
      },
      m,
    );
    const documentId = issueCreditNoteDocument(ctx, {
      ret,
      customer,
      number,
      issuedOn,
      plan: plan.value,
    });
    ctx.audit.record({
      entityType: "sales_return",
      entityId: ret.id,
      action: "issue_unbilled_credit_note",
      before: { invoiceId: null, creditNoteNumber: null },
      after: {
        creditNoteNumber: number,
        issuedOn,
        total: plan.value.summary.total,
        documentId,
        creditPaymentId: paymentId,
      },
    });
    ctx.audit.record({
      entityType: "customer_payment",
      entityId: paymentId,
      action: "create_credit",
      after: {
        customerId: ret.customerId,
        receivedOn: issuedOn,
        amount: amount.value,
        method: "offset",
        salesReturnId: ret.id,
        creditNoteNumber: number,
      },
    });
    return ok({ id: ret.id, number, documentId, paymentId, amount: amount.value });
  },
});

/** 返還額の使い道（請求書に充てた額・返金した額）。返還額がなければ null */
function creditUsageOf(
  ctx: Pick<QueryContext, "stores">,
  paymentId: string | null,
): (CreditUsage & { readonly paymentId: string; readonly version: number }) | null {
  if (paymentId === null) return null;
  const payment = ctx.stores.customerPayments.get(paymentId);
  if (!payment || payment.cancelled) return null;
  const allocated = ctx.stores.customerPayments
    .allocations(paymentId)
    .filter((a) => !a.cancelled)
    .reduce((s, a) => s + a.amount, 0);
  const refunded = ctx.stores.customerPayments
    .refunds(paymentId)
    .filter((r) => !r.cancelled)
    .reduce((s, r) => s + r.amount, 0);
  return { paymentId, version: payment.version, amount: payment.amount, allocated, refunded };
}

/**
 * 請求書で差し引けない返品の返還請求書の取消（返還額を請求書に充てていない・返金していないときだけ。理由が必須）。
 * 返還額の入金を取り消し、帳票を取消済みにして、返品伝票の返還請求書の番号を消す（返品伝票は未請求に戻る）
 */
export const cancelUnbilledCreditNoteCommand = defineCommand({
  permission: "invoices.manage",
  input: z.object({ salesReturnId: idSchema, version, reason: requiredText(500) }),
  run(ctx, { salesReturnId, version: v, reason }) {
    const ret = ctx.stores.salesReturns.get(salesReturnId);
    if (!ret) return err("not_found", "返品伝票が見つかりません");
    const credit = creditUsageOf(ctx, ret.creditPaymentId);
    const next = cancelUnbilledCreditNote(ret, credit);
    if (!next.ok) return next;
    const m = meta(ctx);
    if (!credit || !ctx.stores.salesReturns.clearCreditNote(ret.id, v, m))
      return err("conflict", STALE_VERSION_MESSAGE);
    // 同じトランザクションで読んだ版番号なので、ここで競合することはない
    ctx.stores.customerPayments.cancel(credit.paymentId, credit.version, m);
    for (const documentId of ctx.stores.documents.latestForEntities("credit_note", [ret.id]))
      ctx.documents.cancel(documentId);
    ctx.audit.record({
      entityType: "sales_return",
      entityId: ret.id,
      action: "cancel_unbilled_credit_note",
      before: { creditNoteNumber: ret.creditNoteNumber, creditPaymentId: credit.paymentId },
      after: { creditNoteNumber: null, reason },
    });
    ctx.audit.record({
      entityType: "customer_payment",
      entityId: credit.paymentId,
      action: "cancel_credit",
      before: { cancelled: false },
      after: { cancelled: true, reason, creditNoteNumber: ret.creditNoteNumber },
    });
    return ok({ id: ret.id, salesOrderId: ret.salesOrderId, paymentId: credit.paymentId });
  },
});

// ---- 照会 -----------------------------------------------------------------------

export interface SalesReturnSummary extends SalesReturnRecord {
  /** 返品額の合計（税抜） */
  readonly subtotal: number;
  /** 取り消せるか（状態。権限は画面で判定する） */
  readonly cancellable: boolean;
  /** 請求書で差し引けない返品として返還請求書を発行できるか（状態。権限は画面で判定する） */
  readonly unbilledCreditIssuable: boolean;
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
    unbilledCreditIssuable: unbilledCreditNoteIssuable(ret).ok,
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

/** 返還請求書で精算した返品の返還額（入金の相殺）の使い道 */
export interface SalesReturnCredit extends CreditUsage {
  /** 返還額の入金（/receipts/:id で請求書に消し込む・返金済みにする） */
  readonly paymentId: string;
  /** 残り（請求書に充てるか返金にできる額） */
  readonly remaining: number;
  /** 返還請求書を取り消せるか（状態。権限は画面で判定する） */
  readonly cancellable: boolean;
  readonly cancelBlocker: string | null;
}

export interface SalesReturnView {
  readonly ret: SalesReturnSummary;
  readonly cancelBlocker: string | null;
  readonly creditNote: {
    /**
     * 発行の仕方：billed は請求書に載せた返品（帳票だけ）、unbilled は請求書で差し引けない返品
     * （返品伝票を精算し、返還額を入金の相殺として記録する）。発行できなければ null
     */
    readonly kind: "billed" | "unbilled" | null;
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
  /** 返還請求書で精算した返品の返還額（精算していなければ null） */
  readonly credit: SalesReturnCredit | null;
}

function failure(r: Result<unknown>): string | null {
  return r.ok ? null : r.error.message;
}

/** 返品伝票の詳細（明細、請求書、返還請求書、返還請求書で精算した返還額） */
export const getSalesReturn = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): SalesReturnView | null {
    const ret = ctx.stores.salesReturns.get(id);
    if (!ret) return null;
    const cancellable = cancelSalesReturn(ret);
    const billed = creditNoteIssuable(ret);
    const unbilled = unbilledCreditNoteIssuable(ret);
    const kind = billed.ok ? "billed" : unbilled.ok ? "unbilled" : null;
    const plan = creditNotePlan(ctx, ret);
    const total = plan.ok ? plan.value.summary.total : null;
    // 請求書で差し引けない返品は、返還額が1円以上のときだけ精算できる
    const amount = kind === "unbilled" && total !== null ? creditAmount(total) : null;
    // 発行できない理由：返品伝票の状態（請求書に載っていれば請求済みの返品、載っていなければ請求書で差し引けない返品
    // として確かめる）、税率の設定、0円の返還額
    const blocker =
      kind === null
        ? failure(ret.invoiceId === null ? unbilled : billed)
        : (failure(plan) ?? (amount ? failure(amount) : null));
    const usage = creditUsageOf(ctx, ret.creditPaymentId);
    const creditCancel = usage ? cancelUnbilledCreditNote(ret, usage) : null;
    return {
      ret: summary(ret),
      cancelBlocker: ret.cancelled || cancellable.ok ? null : cancellable.error.message,
      creditNote: {
        kind,
        issuable: kind !== null && blocker === null,
        blocker,
        preview: plan.ok ? plan.value.summary : null,
        obligation: total === null ? null : creditNoteObligation(total),
        documentId:
          ret.creditNoteNumber === null
            ? null
            : (ctx.stores.documents.latestForEntities("credit_note", [ret.id])[0] ?? null),
      },
      credit: usage
        ? {
            paymentId: usage.paymentId,
            amount: usage.amount,
            allocated: usage.allocated,
            refunded: usage.refunded,
            remaining: creditRemaining(usage),
            cancellable: creditCancel?.ok ?? false,
            cancelBlocker: creditCancel && !creditCancel.ok ? creditCancel.error.message : null,
          }
        : null,
    };
  },
});
