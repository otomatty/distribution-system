/**
 * 仕入先請求書と支払（要件定義書 3.7、4章）。
 * - 1枚の請求書に1件以上の入荷を結びつけ、仕入返品を差し引く
 * - システムの計算額と請求額の差額は、理由を入力すれば登録できる
 * - 状態は「未払い → 一部支払 → 支払済み」と取消。残りの額より少ない支払は一部支払で、残りが 0 になるまで支払える。
 *   受入のある入荷がすべて支払済み（残りが 0）の請求書に入ると、対象の発注が支払済みになる
 * - 支払は1回ごとに1件。支払の取消は1件ずつで、状態を決め直す（支払済み・一部支払 → 一部支払・未払い）
 * - 一括支払いは、選んだ請求書の残りの額を1つのトランザクションで支払う（1件でも支払えなければ何もしない）
 */
import { z } from "zod";

import { canAttachToSupplierInvoice } from "../../domain/attachments";
import {
  addDays,
  addMonths,
  isMonth,
  latestClosedPeriod,
  monthOf,
  monthRange,
  monthsBetween,
  paymentDueDate,
} from "../../domain/dates";
import { sumAmounts, type TaxSummary } from "../../domain/money";
import {
  cancelSupplierInvoice,
  cancelSupplierPayment,
  invoiceDifference,
  isSettlementInvoice,
  OPEN_SUPPLIER_INVOICE_STATUSES,
  orderStatusAfterPaymentChange,
  payableBalances,
  paySupplierInvoice,
  registerSupplierInvoice,
  supplierInvoiceAmount,
  supplierInvoiceRemaining,
  type PayableMonth,
  type SupplierInvoiceStatus,
} from "../../domain/purchasing";
import { err, ok, type Result } from "../../domain/result";
import { can } from "../../domain/roles";
import {
  defineCommand,
  defineQuery,
  STALE_VERSION_MESSAGE,
  type QueryContext,
  type UsecaseContext,
} from "../core";
import type { PartnerRecord } from "../masters/partners.port";
import {
  businessDate,
  idSchema,
  optionalBusinessDate,
  optionalText,
  pageInput,
  requiredText,
  version,
  yen,
  type Page,
} from "../schemas";
import { closingTermsOf, fieldError, taxRatesOn, writeMeta } from "./common";
import type { ReceiptRecord } from "./receipts.port";
import type {
  InvoiceReceiptRow,
  InvoiceReturnRow,
  SupplierInvoiceAttachmentRecord,
  SupplierInvoiceFilter,
  SupplierInvoiceRecord,
  SupplierInvoiceTotals,
  SupplierPaymentRecord,
} from "./supplier-invoices.port";

export const SUPPLIER_INVOICE_STATUSES = [
  "unpaid",
  "partial",
  "paid",
  "cancelled",
] as const satisfies readonly SupplierInvoiceStatus[];

/** 請求額（返品が多い月はマイナスもありうる） */
const signedYen = z
  .number({ error: "金額は円単位の数字で入力してください" })
  .int("金額は円単位の整数で入力してください")
  .min(-9_999_999_999, "金額が大きすぎます")
  .max(9_999_999_999, "金額が大きすぎます");

export interface InvoiceAmounts {
  readonly summary: TaxSummary;
  readonly computedAmount: number;
  /** 入荷の受入数 × 単価の合計（税抜） */
  readonly receiptsSubtotal: number;
  /** 仕入返品の合計（税抜、正の数） */
  readonly returnsSubtotal: number;
  /** 送料（税込、請求書に書かれた額） */
  readonly shippingFee: number;
}

function computeAmounts(
  ctx: Pick<QueryContext, "stores">,
  invoiceDate: string,
  receipts: readonly InvoiceReceiptRow[],
  returns: readonly InvoiceReturnRow[],
  shippingFee: number,
): Result<InvoiceAmounts> {
  const rates = taxRatesOn(ctx, invoiceDate);
  if (!rates.ok) return rates;
  const receiptLines = receipts.flatMap((r) => r.amounts);
  const returnLines = returns.flatMap((r) => r.amounts);
  const { summary, computedAmount } = supplierInvoiceAmount(
    receiptLines,
    returnLines,
    shippingFee,
    rates.value,
    ctx.stores.settings.getCompany().roundingMode,
  );
  return ok({
    summary,
    computedAmount,
    receiptsSubtotal: sumAmounts(receiptLines),
    returnsSubtotal: sumAmounts(returnLines),
    shippingFee,
  });
}

/** 取引条件のある仕入先は、対象の入荷のうち最も新しい入荷日から支払予定日を計算する */
function suggestedDueOn(
  supplier: PartnerRecord,
  receipts: readonly InvoiceReceiptRow[],
): string | null {
  const terms = closingTermsOf(supplier);
  const latest = receipts.reduce<string | null>(
    (max, r) => (max === null || r.receivedOn > max ? r.receivedOn : max),
    null,
  );
  return terms && latest ? paymentDueDate(latest, terms) : null;
}

function supplierOf(ctx: Pick<QueryContext, "stores">, supplierId: string): Result<PartnerRecord> {
  const supplier = ctx.stores.partners.get(supplierId);
  if (!supplier || !supplier.isSupplier) return fieldError("supplierId", "仕入先を選んでください");
  return ok(supplier);
}

export interface InvoiceCandidates {
  readonly supplier: { id: string; name: string; hasTerms: boolean };
  /** 締め日のある仕入先の、請求日の時点で締め終わっている締め期間（その期間の入荷を選んでおく） */
  readonly period: { from: string; to: string } | null;
  readonly receipts: readonly (InvoiceReceiptRow & { subtotal: number; inPeriod: boolean })[];
  readonly returns: readonly (InvoiceReturnRow & { subtotal: number; inPeriod: boolean })[];
}

/**
 * 仕入先請求書の登録画面：まだ請求書に結びついていない入荷と仕入先返品。
 * 締め日のある仕入先は、締め期間内のものを選んだ状態（inPeriod）で返す。締め日のない仕入先は何も選ばない。
 */
export const supplierInvoiceCandidates = defineQuery({
  permission: "view",
  input: z.object({ supplierId: idSchema, invoiceDate: businessDate }),
  run(ctx, { supplierId, invoiceDate }): InvoiceCandidates | null {
    const supplier = ctx.stores.partners.get(supplierId);
    if (!supplier || !supplier.isSupplier) return null;
    const terms = closingTermsOf(supplier);
    const period = terms ? latestClosedPeriod(invoiceDate, terms.closingDay) : null;
    const within = (date: string) => period !== null && date >= period.from && date <= period.to;
    const { receipts, returns } = ctx.stores.supplierInvoices.candidates(supplierId);
    return {
      supplier: { id: supplier.id, name: supplier.name, hasTerms: terms !== null },
      period,
      receipts: receipts.map((r) =>
        Object.assign(r, { subtotal: sumAmounts(r.amounts), inPeriod: within(r.receivedOn) }),
      ),
      returns: returns.map((r) =>
        Object.assign(r, { subtotal: sumAmounts(r.amounts), inPeriod: within(r.returnedOn) }),
      ),
    };
  },
});

const selectionInput = {
  supplierId: idSchema,
  invoiceDate: businessDate,
  receiptIds: z.array(idSchema).max(500).default([]),
  returnIds: z.array(idSchema).max(500).default([]),
  shippingFee: yen.default(0),
};

/** 選んだ入荷・仕入返品のうち、まだ請求書に結びついていないもの（ほかの仕入先・取消済みは除く） */
function selected(
  ctx: Pick<QueryContext, "stores">,
  supplierId: string,
  receiptIds: readonly string[],
  returnIds: readonly string[],
) {
  const { receipts, returns } = ctx.stores.supplierInvoices.candidates(supplierId);
  const r = new Set(receiptIds);
  const p = new Set(returnIds);
  return {
    receipts: receipts.filter((x) => r.has(x.id)),
    returns: returns.filter((x) => p.has(x.id)),
    unknown:
      [...r].filter((id) => !receipts.some((x) => x.id === id)).length +
      [...p].filter((id) => !returns.some((x) => x.id === id)).length,
  };
}

export interface InvoicePreview {
  readonly error: string | null;
  readonly amounts: InvoiceAmounts | null;
  /** 請求額 − 計算額（請求額が未入力なら null） */
  readonly difference: number | null;
  /** 取引条件からの支払予定日 */
  readonly suggestedDueOn: string | null;
  readonly receiptCount: number;
  readonly returnCount: number;
}

/** 登録画面で、チェックのたびに計算額と差額をその場で計算する（保存はしない） */
export const previewSupplierInvoice = defineQuery({
  permission: "view",
  input: z.object({ ...selectionInput, invoicedAmount: z.number().int().nullable().default(null) }),
  run(ctx, input): InvoicePreview {
    const s = selected(ctx, input.supplierId, input.receiptIds, input.returnIds);
    const empty = {
      amounts: null,
      difference: null,
      suggestedDueOn: null,
      receiptCount: s.receipts.length,
      returnCount: s.returns.length,
    };
    const supplier = supplierOf(ctx, input.supplierId);
    if (!supplier.ok) return { ...empty, error: supplier.error.message };
    const amounts = computeAmounts(
      ctx,
      input.invoiceDate,
      s.receipts,
      s.returns,
      input.shippingFee,
    );
    if (!amounts.ok) return { ...empty, error: amounts.error.message };
    return {
      ...empty,
      error: null,
      amounts: amounts.value,
      difference:
        input.invoicedAmount === null ? null : input.invoicedAmount - amounts.value.computedAmount,
      suggestedDueOn: suggestedDueOn(supplier.value, s.receipts),
    };
  },
});

export const createSupplierInvoice = defineCommand({
  permission: "supplierInvoices.manage",
  input: z.object({
    ...selectionInput,
    invoiceNumber: optionalText(50),
    invoicedAmount: signedYen,
    differenceReason: optionalText(500),
    /** 空なら取引条件から計算する */
    paymentDueOn: optionalBusinessDate,
    memo: optionalText(1000),
  }),
  run(ctx, input) {
    const supplier = supplierOf(ctx, input.supplierId);
    if (!supplier.ok) return supplier;
    const s = selected(ctx, input.supplierId, input.receiptIds, input.returnIds);
    if (s.unknown > 0)
      return err(
        "invalid_state",
        "選んだ入荷・仕入返品の中に、ほかの請求書に結びついたもの・取り消されたものがあります。画面を開き直してください",
      );
    const status = registerSupplierInvoice(s.receipts.length);
    if (!status.ok) return status;
    const amounts = computeAmounts(
      ctx,
      input.invoiceDate,
      s.receipts,
      s.returns,
      input.shippingFee,
    );
    if (!amounts.ok) return amounts;
    const difference = invoiceDifference(
      input.invoicedAmount,
      amounts.value.computedAmount,
      input.differenceReason ?? "",
    );
    if (!difference.ok) return difference;
    const id = ctx.ids.next();
    const fields = {
      supplierId: input.supplierId,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      invoicedAmount: input.invoicedAmount,
      shippingFee: input.shippingFee,
      computedAmount: amounts.value.computedAmount,
      difference: difference.value,
      differenceReason: difference.value === 0 ? null : input.differenceReason,
      paymentDueOn: input.paymentDueOn ?? suggestedDueOn(supplier.value, s.receipts),
      memo: input.memo,
    };
    ctx.stores.supplierInvoices.insert(id, fields, writeMeta(ctx));
    ctx.stores.supplierInvoices.setReceiptInvoice(
      s.receipts.map((r) => r.id),
      id,
    );
    ctx.stores.supplierInvoices.setReturnInvoice(
      s.returns.map((r) => r.id),
      id,
    );
    ctx.audit.record({
      entityType: "supplier_invoice",
      entityId: id,
      action: "create",
      after: {
        status: status.value,
        ...fields,
        receiptIds: s.receipts.map((r) => r.id),
        returnIds: s.returns.map((r) => r.id),
      },
    });
    return ok({ id });
  },
});

/**
 * 請求書の支払・支払の取消・取消のあとに、発注の状態を決め直す（domain の orderStatusAfterPaymentChange）。
 * 支払済みの請求書に入っていない、受入のある入荷の件数は、請求書の状態を変えた後の値で数える。
 * orderIds は請求書に結びついていた入荷の発注（取消では、入荷を外す前に読んでおく）。
 * ref は操作履歴に残す、きっかけの伝票（{ supplierInvoiceId } など）。変えた発注の ID を返す。
 */
export function settleOrders(
  ctx: UsecaseContext,
  orderIds: readonly string[],
  action: string,
  ref: Readonly<Record<string, string>>,
): string[] {
  const changed: string[] = [];
  for (const orderId of orderIds) {
    const po = ctx.stores.purchaseOrders.get(orderId);
    if (!po) continue;
    const status = orderStatusAfterPaymentChange(
      po.status,
      po.lines,
      ctx.stores.supplierInvoices.unpaidReceiptCount(po.id),
    );
    if (status === po.status) continue;
    ctx.stores.purchaseOrders.setStatus(po.id, status, writeMeta(ctx));
    ctx.audit.record({
      entityType: "purchase_order",
      entityId: po.id,
      action,
      before: { status: po.status },
      after: { status, ...ref },
    });
    changed.push(po.id);
  }
  return changed;
}

function orderIdsOf(ctx: UsecaseContext, invoiceId: string): string[] {
  return ctx.stores.supplierInvoices.ordersOf(invoiceId).map((o) => o.id);
}

function applyPayment(
  ctx: UsecaseContext,
  invoice: SupplierInvoiceRecord,
  expectedVersion: number,
  payment: { paidOn: string; amount: number; memo: string | null },
): Result<{ paymentId: string; status: SupplierInvoiceStatus }> {
  const next = paySupplierInvoice(
    invoice.status,
    invoice.invoicedAmount,
    invoice.paidAmount,
    payment.amount,
  );
  if (!next.ok) return next;
  const patch = { status: next.value.status, paidAmount: next.value.paidAmount };
  if (!ctx.stores.supplierInvoices.update(invoice.id, expectedVersion, patch, writeMeta(ctx)))
    return err("conflict", STALE_VERSION_MESSAGE);
  const paymentId = ctx.ids.next();
  ctx.stores.supplierInvoices.insertPayment(paymentId, invoice.id, payment, writeMeta(ctx));
  const orders = settleOrders(ctx, orderIdsOf(ctx, invoice.id), "pay", {
    supplierInvoiceId: invoice.id,
  });
  ctx.audit.record({
    entityType: "supplier_invoice",
    entityId: invoice.id,
    action: "pay",
    before: { status: invoice.status, paidAmount: invoice.paidAmount },
    after: { ...patch, paymentId, ...payment, paidOrderIds: orders },
  });
  return ok({ paymentId, status: next.value.status });
}

/**
 * 支払（支払日と支払額を記録する）。支払額は残りの額まで。残りより少なければ一部支払、残りと同じなら支払済み。
 * 請求額が 0 円以下の請求書は、請求額と同じ額（0 円・マイナス）で精算する
 * （domain の paySupplierInvoice。マイナスの支払額は「相殺・返金を受ける額」）
 */
export const paySupplierInvoiceCommand = defineCommand({
  permission: "supplierInvoices.manage",
  input: z.object({
    id: idSchema,
    version,
    paidOn: businessDate,
    amount: signedYen,
    memo: optionalText(500),
  }),
  run(ctx, { id, version: v, paidOn, amount, memo }) {
    const invoice = ctx.stores.supplierInvoices.get(id);
    if (!invoice) return err("not_found", "仕入先請求書が見つかりません");
    const paid = applyPayment(ctx, invoice, v, { paidOn, amount, memo });
    if (!paid.ok) return paid;
    return ok({ id, paymentId: paid.value.paymentId, status: paid.value.status });
  },
});

/**
 * 一括支払い：選んだ請求書を、それぞれの残りの額（請求額 − 支払済みの額）で支払済みにする。一部支払の請求書は
 * 残りの額を払う。1つのトランザクションで処理し、1件でも支払えないもの（支払済み・取消・ほかの人の更新）があれば、
 * どれも支払わずに理由を返す。請求額が 0 円以下の請求書も、請求額（0 円・マイナス）で精算する（個別の支払と同じ規則）。
 * amount は支払った額（差し引き）の合計
 */
export const payBulkSupplierInvoices = defineCommand({
  permission: "supplierInvoices.manage",
  input: z.object({
    invoices: z
      .array(z.object({ id: idSchema, version }))
      .min(1, "支払う請求書を選んでください")
      .max(200, "一度に支払えるのは200件までです"),
    paidOn: businessDate,
    memo: optionalText(500),
  }),
  run(ctx, { invoices, paidOn, memo }) {
    const problems: string[] = [];
    const targets: { invoice: SupplierInvoiceRecord; version: number }[] = [];
    const seen = new Set<string>();
    for (const t of invoices) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const invoice = ctx.stores.supplierInvoices.get(t.id);
      if (!invoice) {
        problems.push("見つからない請求書が含まれています");
        continue;
      }
      const label = `${invoice.supplierName} ${invoice.invoiceNumber ?? "（番号なし）"}`;
      const check = paySupplierInvoice(
        invoice.status,
        invoice.invoicedAmount,
        invoice.paidAmount,
        supplierInvoiceRemaining(invoice),
      );
      if (!check.ok) problems.push(`${label}：${check.error.message}`);
      else if (invoice.version !== t.version) problems.push(`${label}：${STALE_VERSION_MESSAGE}`);
      else targets.push({ invoice, version: t.version });
    }
    if (problems.length > 0)
      return err("invalid_state", "支払えない請求書があるため、どれも支払っていません", {
        details: problems,
      });
    let amount = 0;
    for (const t of targets) {
      const remaining = supplierInvoiceRemaining(t.invoice);
      const paid = applyPayment(ctx, t.invoice, t.version, { paidOn, amount: remaining, memo });
      if (!paid.ok) return paid;
      amount += remaining;
    }
    return ok({ count: targets.length, amount, ids: targets.map((t) => t.invoice.id) });
  },
});

/**
 * 支払1件の取消。取り消していない支払が残れば一部支払、残らなければ未払いに戻る（domain の cancelSupplierPayment）。
 * 支払済みだった発注は入荷済みに戻る。版番号は請求書の版（支払・支払の取消のたびに上がる）
 */
export const cancelSupplierPaymentCommand = defineCommand({
  permission: "supplierInvoices.manage",
  input: z.object({ id: idSchema, version, paymentId: idSchema, reason: requiredText(500) }),
  run(ctx, { id, version: v, paymentId, reason }) {
    const invoice = ctx.stores.supplierInvoices.get(id);
    if (!invoice) return err("not_found", "仕入先請求書が見つかりません");
    const payments = ctx.stores.supplierInvoices.payments(id);
    const payment = payments.find((p) => p.id === paymentId);
    if (!payment) return err("not_found", "支払が見つかりません");
    const others = payments.filter((p) => !p.cancelled && p.id !== paymentId).length;
    const next = cancelSupplierPayment(invoice.status, invoice.paidAmount, payment, others, reason);
    if (!next.ok) return next;
    const meta = writeMeta(ctx);
    const patch = { status: next.value.status, paidAmount: next.value.paidAmount };
    if (!ctx.stores.supplierInvoices.update(id, v, patch, meta))
      return err("conflict", STALE_VERSION_MESSAGE);
    // 同じトランザクションで読んで、取り消していないことを確かめた支払なので、ここで失敗することはない
    ctx.stores.supplierInvoices.cancelPayment(id, paymentId, reason, meta);
    const orders = settleOrders(ctx, orderIdsOf(ctx, id), "cancel_payment", {
      supplierInvoiceId: id,
    });
    ctx.audit.record({
      entityType: "supplier_invoice",
      entityId: id,
      action: "cancel_payment",
      before: { status: invoice.status, paidAmount: invoice.paidAmount, payment },
      after: { ...patch, paymentId, reason, orderIds: orders },
    });
    return ok({ id, status: next.value.status });
  },
});

/**
 * 仕入先請求書の取消。取り消していない支払が残っていれば（一部支払・支払済み）取り消せない。
 * 結びつけた入荷・仕入返品は外れ、別の請求書に入れ直せる
 */
export const cancelSupplierInvoiceCommand = defineCommand({
  permission: "supplierInvoices.manage",
  input: z.object({ id: idSchema, version, reason: requiredText(500) }),
  run(ctx, { id, version: v, reason }) {
    const invoice = ctx.stores.supplierInvoices.get(id);
    if (!invoice) return err("not_found", "仕入先請求書が見つかりません");
    const next = cancelSupplierInvoice(invoice.status, reason);
    if (!next.ok) return next;
    if (
      !ctx.stores.supplierInvoices.update(
        id,
        v,
        { status: next.value, cancelReason: reason },
        writeMeta(ctx),
      )
    )
      return err("conflict", STALE_VERSION_MESSAGE);
    const receiptIds = ctx.stores.supplierInvoices.linkedReceipts(id).map((r) => r.id);
    const returnIds = ctx.stores.supplierInvoices.linkedReturns(id).map((r) => r.id);
    const orderIds = orderIdsOf(ctx, id);
    ctx.stores.supplierInvoices.setReceiptInvoice(receiptIds, null);
    ctx.stores.supplierInvoices.setReturnInvoice(returnIds, null);
    // 未払いの請求書の入荷は未払いのままなので、通常は発注の状態は変わらない（遷移の規則を1か所にするため決め直す）
    const orders = settleOrders(ctx, orderIds, "cancel_supplier_invoice", {
      supplierInvoiceId: id,
    });
    ctx.audit.record({
      entityType: "supplier_invoice",
      entityId: id,
      action: "cancel",
      before: { status: invoice.status, receiptIds, returnIds },
      after: { status: next.value, reason, orderIds: orders },
    });
    return ok({ id });
  },
});

/**
 * 入荷の取消で、未払いの請求書からその入荷を外し、計算額と差額を計算し直す。
 * 差額が出て理由がなければ、取消のためと記録する（経理が請求書の画面で確かめる）。
 */
export function detachReceiptFromInvoice(
  ctx: UsecaseContext,
  invoiceId: string,
  receipt: Pick<ReceiptRecord, "id" | "number">,
): Result<true> {
  const invoice = ctx.stores.supplierInvoices.get(invoiceId);
  if (!invoice || invoice.status !== "unpaid") return ok(true);
  ctx.stores.supplierInvoices.setReceiptInvoice([receipt.id], null);
  const amounts = computeAmounts(
    ctx,
    invoice.invoiceDate,
    ctx.stores.supplierInvoices.linkedReceipts(invoiceId),
    ctx.stores.supplierInvoices.linkedReturns(invoiceId),
    invoice.shippingFee,
  );
  if (!amounts.ok) return amounts;
  const difference = invoice.invoicedAmount - amounts.value.computedAmount;
  const differenceReason =
    difference === 0
      ? invoice.differenceReason
      : (invoice.differenceReason ?? `入荷 ${receipt.number} の取消で計算額が変わりました`);
  const patch = { computedAmount: amounts.value.computedAmount, difference, differenceReason };
  if (!ctx.stores.supplierInvoices.update(invoiceId, invoice.version, patch, writeMeta(ctx)))
    return err("conflict", STALE_VERSION_MESSAGE);
  ctx.audit.record({
    entityType: "supplier_invoice",
    entityId: invoiceId,
    action: "detach_receipt",
    before: {
      computedAmount: invoice.computedAmount,
      difference: invoice.difference,
      differenceReason: invoice.differenceReason,
    },
    after: { ...patch, receiptId: receipt.id },
  });
  return ok(true);
}

// ---- 照会 -----------------------------------------------------------------------

export interface SupplierInvoiceView {
  readonly invoice: SupplierInvoiceRecord;
  readonly receipts: readonly (InvoiceReceiptRow & { subtotal: number })[];
  readonly returns: readonly (InvoiceReturnRow & { subtotal: number })[];
  readonly payments: readonly SupplierPaymentRecord[];
  /** 添付した PDF のすべての版（新しい順。先頭が今の版）。versionNo は1から数えた版 */
  readonly attachments: readonly (SupplierInvoiceAttachmentRecord & { versionNo: number })[];
  /** 今の結びつきで計算した税率ごとの内訳（税率表にない日付なら null） */
  readonly amounts: InvoiceAmounts | null;
  /** 請求額が 0 円以下で、支払ではなく請求額での精算（相殺・返金を受ける）になる */
  readonly settlement: boolean;
  /** 残りの支払額（請求額 − 支払済みの額。支払の欄の初期値） */
  readonly remaining: number;
  /** 操作者が今できる操作（状態と権限から決める） */
  readonly actions: {
    readonly pay: boolean;
    readonly cancel: boolean;
    /** PDF を添付できるか（新しい版の追加を含む） */
    readonly attach: boolean;
  };
  /** 操作者が取り消せる支払の ID（取り消していない支払） */
  readonly cancellablePaymentIds: readonly string[];
}

export const getSupplierInvoice = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): SupplierInvoiceView | null {
    const invoice = ctx.stores.supplierInvoices.get(id);
    if (!invoice) return null;
    const manage = can(ctx.actor.roles, "supplierInvoices.manage");
    const receipts = ctx.stores.supplierInvoices.linkedReceipts(id);
    const returns = ctx.stores.supplierInvoices.linkedReturns(id);
    const attachments = ctx.stores.supplierInvoices.attachments(id);
    const amounts = computeAmounts(
      ctx,
      invoice.invoiceDate,
      receipts,
      returns,
      invoice.shippingFee,
    );
    const payments = ctx.stores.supplierInvoices.payments(id);
    const live = payments.filter((p) => !p.cancelled).length;
    const remaining = supplierInvoiceRemaining(invoice);
    return {
      invoice,
      receipts: receipts.map((r) => Object.assign(r, { subtotal: sumAmounts(r.amounts) })),
      returns: returns.map((r) => Object.assign(r, { subtotal: sumAmounts(r.amounts) })),
      payments,
      attachments: attachments.map((a, i) =>
        Object.assign(a, { versionNo: attachments.length - i }),
      ),
      amounts: amounts.ok ? amounts.value : null,
      settlement: isSettlementInvoice(invoice.invoicedAmount),
      remaining,
      actions: {
        pay:
          manage &&
          paySupplierInvoice(invoice.status, invoice.invoicedAmount, invoice.paidAmount, remaining)
            .ok,
        cancel: manage && cancelSupplierInvoice(invoice.status, "取消").ok,
        attach: manage && canAttachToSupplierInvoice(invoice.status).ok,
      },
      cancellablePaymentIds: manage
        ? payments
            .filter(
              (p) =>
                cancelSupplierPayment(invoice.status, invoice.paidAmount, p, live - 1, "取消").ok,
            )
            .map((p) => p.id)
        : [],
    };
  },
});

/** 検索の金額（請求額はマイナスもありうる）。未入力は undefined */
const searchAmount = z
  .number({ error: "金額は数字で入力してください" })
  .int("円単位の整数で入力してください")
  .min(-9_999_999_999, "金額が大きすぎます")
  .max(9_999_999_999, "金額が大きすぎます")
  .nullable()
  .optional()
  .transform((v) => v ?? undefined);

/**
 * 仕入先請求書の一覧の絞り込み。電子帳簿保存法（要件定義書 7章）の検索の要件に合わせ、取引年月日（請求日）・
 * 取引金額（請求額）・取引先（仕入先）を、範囲の指定と組み合わせで指定できる
 */
const supplierInvoiceSearchInput = pageInput
  .extend({
    status: z.enum(SUPPLIER_INVOICE_STATUSES).optional(),
    supplierId: z.string().max(64).optional(),
    from: optionalBusinessDate,
    to: optionalBusinessDate,
    amountMin: searchAmount,
    amountMax: searchAmount,
    q: z.string().trim().max(100).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.from && v.to && v.from > v.to) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "終わりの日付は始まりの日付以降にしてください",
      });
    }
    if (v.amountMin !== undefined && v.amountMax !== undefined && v.amountMin > v.amountMax) {
      ctx.addIssue({
        code: "custom",
        path: ["amountMax"],
        message: "上限の金額は下限の金額以上にしてください",
      });
    }
  });

export interface SupplierInvoiceListItem extends SupplierInvoiceRecord {
  /** 請求額が 0 円以下で、支払ではなく請求額での精算（相殺・返金を受ける）になる */
  readonly settlement: boolean;
  /** 残りの支払額（請求額 − 支払済みの額。取消は 0） */
  readonly remaining: number;
}

function listItems(page: Page<SupplierInvoiceRecord>): Page<SupplierInvoiceListItem> {
  return {
    ...page,
    rows: page.rows.map((r) => ({
      ...r,
      settlement: isSettlementInvoice(r.invoicedAmount),
      remaining: supplierInvoiceRemaining(r),
    })),
  };
}

/** 仕入先請求書の一覧（状態・仕入先・請求日の範囲・請求額の範囲・キーワード） */
export const listSupplierInvoices = defineQuery({
  permission: "view",
  input: supplierInvoiceSearchInput,
  run(ctx, { page, pageSize, ...f }): Page<SupplierInvoiceListItem> {
    return listItems(
      ctx.stores.supplierInvoices.list(
        {
          statuses: f.status ? [f.status] : undefined,
          supplierId: f.supplierId || undefined,
          from: f.from ?? undefined,
          to: f.to ?? undefined,
          amountMin: f.amountMin,
          amountMax: f.amountMax,
          q: f.q || undefined,
        },
        page,
        pageSize,
      ),
    );
  },
});

export const payablesFilterInput = {
  /** 未払い・一部支払のどちらか（省くと両方） */
  status: z.enum(OPEN_SUPPLIER_INVOICE_STATUSES).optional(),
  supplierId: z.string().max(64).optional(),
  dueFrom: optionalBusinessDate,
  dueTo: optionalBusinessDate,
  /** 支払予定日を過ぎたものだけ */
  overdue: z.boolean().default(false),
};

function payablesFilter(
  ctx: Pick<QueryContext, "clock">,
  f: z.output<z.ZodObject<typeof payablesFilterInput>>,
): SupplierInvoiceFilter {
  const yesterday = f.overdue ? addDays(ctx.clock.today(), -1) : undefined;
  const dueTo = f.dueTo ?? undefined;
  return {
    statuses: f.status ? [f.status] : OPEN_SUPPLIER_INVOICE_STATUSES,
    supplierId: f.supplierId || undefined,
    dueFrom: f.dueFrom ?? undefined,
    dueTo: yesterday && (!dueTo || yesterday < dueTo) ? yesterday : dueTo,
  };
}

/**
 * 支払予定一覧：支払の残っている（未払い・一部支払の）仕入先請求書（支払予定日の順）と、条件に合うものの
 * 件数・請求額・支払済みの額・残りの額の合計
 */
export const listPayables = defineQuery({
  permission: "view",
  input: pageInput.extend(payablesFilterInput),
  run(
    ctx,
    { page, pageSize, ...f },
  ): Page<SupplierInvoiceListItem> & {
    totals: SupplierInvoiceTotals;
  } {
    const filter = payablesFilter(ctx, f);
    return {
      ...listItems(ctx.stores.supplierInvoices.list(filter, page, pageSize)),
      totals: ctx.stores.supplierInvoices.totals(filter),
    };
  },
});

export interface PayableBalanceRow {
  readonly supplierId: string;
  readonly supplierName: string;
  /** 期間の前月末の残高 */
  readonly opening: number;
  readonly months: readonly PayableMonth[];
}

/**
 * 仕入先別・月別の買掛残高：月末の残高 = 前月末の残高 + 当月の請求額（請求日の月）− 当月の支払額（支払日の月）。
 * 期間を省くと、今月までの6か月。取消した請求書・支払は含めない。
 */
export const payableBalancesQuery = defineQuery({
  permission: "view",
  input: z.object({
    from: z.string().refine(isMonth, "月を正しく入力してください").optional(),
    to: z.string().refine(isMonth, "月を正しく入力してください").optional(),
    supplierId: z.string().max(64).optional(),
  }),
  run(ctx, input): { months: string[]; rows: PayableBalanceRow[] } {
    const to = input.to ?? monthOf(ctx.clock.today());
    const from = input.from ?? addMonths(to, -5);
    const months = monthsBetween(from, to, 24);
    const first = months[0];
    const last = months.at(-1);
    if (first === undefined || last === undefined) return { months: [], rows: [] };
    const supplierId = input.supplierId || undefined;
    const opening = ctx.stores.supplierInvoices.openingBalances(monthRange(first).from, supplierId);
    const monthly = ctx.stores.supplierInvoices.monthly(
      monthRange(first).from,
      monthRange(last).to,
      supplierId,
    );
    const names = new Map<string, string>();
    const openingBy = new Map<string, number>();
    for (const o of opening) {
      names.set(o.supplierId, o.supplierName);
      openingBy.set(o.supplierId, o.balance);
    }
    const bySupplier = new Map<string, Map<string, { invoiced: number; paid: number }>>();
    for (const m of monthly) {
      names.set(m.supplierId, m.supplierName);
      const map =
        bySupplier.get(m.supplierId) ?? new Map<string, { invoiced: number; paid: number }>();
      const prev = map.get(m.month) ?? { invoiced: 0, paid: 0 };
      map.set(m.month, { invoiced: prev.invoiced + m.invoiced, paid: prev.paid + m.paid });
      bySupplier.set(m.supplierId, map);
    }
    const rows = [...names.entries()]
      .map(([id, name]): PayableBalanceRow => {
        const o = openingBy.get(id) ?? 0;
        return {
          supplierId: id,
          supplierName: name,
          opening: o,
          months: payableBalances(o, months, bySupplier.get(id) ?? new Map()),
        };
      })
      .filter((r) => r.opening !== 0 || r.months.some((m) => m.invoiced !== 0 || m.paid !== 0))
      .toSorted((a, b) => a.supplierName.localeCompare(b.supplierName, "ja"));
    return { months, rows };
  },
});
