/**
 * 入金と消込・売掛残高（要件定義書 3.11、4章 請求書の状態遷移）。
 * - 入金は独立したデータ（入金日・入金額・方法・メモ）として記録し、その販売先の未入金・一部入金の請求書に消し込む。
 *   1件の入金を複数の請求書に、1枚の請求書に複数の入金を当てられる。差額は振込手数料・値引き・その他として処理する
 * - 請求残高を超えては消し込めない。入金が請求より多い場合、残りは入金の未消込残高として残り、後で消し込める
 * - 消込の取消で、請求書は入金済み → 一部入金・未入金に戻る
 * - 入金の取消は、その入金の有効な消込もまとめて取り消す（理由は操作履歴に残す）
 */
import { z } from "zod";

import {
  applyAllocation,
  cancelPayment,
  invoiceOutstanding,
  isOverdue,
  paymentUnallocated,
  planAllocations,
  receivable,
  releaseAllocation,
  type Receivable,
} from "../../domain/billing";
import { err, ok, type Result } from "../../domain/result";
import {
  defineCommand,
  defineQuery,
  STALE_VERSION_MESSAGE,
  type QueryContext,
  type UsecaseContext,
} from "../core";
import {
  businessDate,
  idSchema,
  nonNegativeInt,
  optionalBusinessDate,
  optionalText,
  pageInput,
  requiredText,
  version,
  yen,
  type Page,
} from "../schemas";
import type { InvoiceRecord } from "./invoices.port";
import type {
  AllocationRecord,
  CustomerPaymentListRow,
  CustomerPaymentRecord,
  ReceivableRow,
} from "./payments.port";

function meta(ctx: UsecaseContext) {
  return { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId };
}

function conflict(): Result<never> {
  return err("conflict", STALE_VERSION_MESSAGE);
}

const allocationInput = z.object({
  invoiceId: idSchema,
  /** 画面を開いたときの請求書の版番号 */
  version,
  amount: z.number({ error: "消込額は数字で入力してください" }).pipe(nonNegativeInt),
  adjustment: z.number({ error: "差額は数字で入力してください" }).pipe(nonNegativeInt).default(0),
  adjustmentKind: z.enum(["bank_fee", "discount", "other"]).nullable().default(null),
});

type AllocationInput = z.output<typeof allocationInput>;

/**
 * 入金を請求書に消し込む（入金の登録と、後からの消込で共通）。
 * 請求書は販売先のもので、画面を開いたときの版番号のまま、未入金・一部入金であること
 */
function allocate(
  ctx: UsecaseContext,
  payment: { readonly id: string; readonly customerId: string; readonly amount: number },
  alreadyAllocated: number,
  inputs: readonly AllocationInput[],
): Result<{ allocationIds: string[]; remaining: number }> {
  const open = new Map(
    ctx.stores.invoices.openForCustomer(payment.customerId).map((i) => [i.id, i]),
  );
  for (const [i, a] of inputs.entries()) {
    // 金額を入れなかった行は消し込まないので、請求書の状態も版番号も確かめない
    if (a.amount === 0 && a.adjustment === 0) continue;
    const invoice = open.get(a.invoiceId);
    if (!invoice) {
      const message = "この販売先の未入金・一部入金の請求書ではありません";
      return err("conflict", message, {
        fields: [{ field: `allocations.${i}.invoiceId`, message }],
      });
    }
    if (invoice.version !== a.version) return conflict();
  }
  const plan = planAllocations(
    payment.amount,
    alreadyAllocated,
    inputs,
    new Map([...open.values()].map((i) => [i.id, invoiceOutstanding(i)])),
  );
  if (!plan.ok) return plan;
  const m = meta(ctx);
  const rows = plan.value.allocations.map((a) => ({
    id: ctx.ids.next(),
    paymentId: payment.id,
    invoiceId: a.invoiceId,
    amount: a.amount,
    adjustment: a.adjustment,
    adjustmentKind: a.adjustmentKind,
  }));
  ctx.stores.customerPayments.insertAllocations(rows, m);
  for (const row of rows) {
    const invoice = open.get(row.invoiceId);
    if (!invoice) return conflict();
    const next = applyAllocation(invoice, row.amount + row.adjustment);
    if (!next.ok) return next;
    if (!ctx.stores.invoices.update(invoice.id, invoice.version, next.value, m)) return conflict();
    ctx.audit.record({
      entityType: "invoice",
      entityId: invoice.id,
      action: "allocate",
      before: { status: invoice.status, allocated: invoice.allocated },
      after: { ...next.value, allocationId: row.id, paymentId: payment.id },
    });
  }
  return ok({ allocationIds: rows.map((r) => r.id), remaining: plan.value.remaining });
}

/** 入金の記録（と、同時に請求書への消込） */
export const createCustomerPayment = defineCommand({
  permission: "payments.manage",
  input: z.object({
    customerId: z.string().min(1, "販売先を選んでください").max(64),
    receivedOn: businessDate,
    amount: z
      .number({ error: "入金額は円単位の数字で入力してください" })
      .pipe(yen)
      .refine((n) => n >= 1, "入金額は1円以上で入力してください"),
    method: z.enum(["transfer", "cash", "offset", "other"]),
    memo: optionalText(500),
    allocations: z.array(allocationInput).max(200).default([]),
  }),
  run(ctx, input) {
    const customer = ctx.stores.partners.get(input.customerId);
    if (!customer || !customer.isCustomer) {
      const message = "販売先を選んでください";
      return err("validation", message, { fields: [{ field: "customerId", message }] });
    }
    if (input.receivedOn > ctx.clock.today()) {
      const message = "今日より後の日付は入力できません";
      return err("validation", message, { fields: [{ field: "receivedOn", message }] });
    }
    const id = ctx.ids.next();
    ctx.stores.customerPayments.insert(
      {
        id,
        customerId: customer.id,
        receivedOn: input.receivedOn,
        amount: input.amount,
        method: input.method,
        memo: input.memo,
      },
      meta(ctx),
    );
    const allocated = allocate(
      ctx,
      { id, customerId: customer.id, amount: input.amount },
      0,
      input.allocations,
    );
    if (!allocated.ok) return allocated;
    ctx.audit.record({
      entityType: "customer_payment",
      entityId: id,
      action: "create",
      after: {
        customerId: customer.id,
        receivedOn: input.receivedOn,
        amount: input.amount,
        method: input.method,
        memo: input.memo,
        allocationIds: allocated.value.allocationIds,
      },
    });
    return ok({ id, ...allocated.value });
  },
});

function activeAllocations(
  ctx: Pick<QueryContext, "stores">,
  paymentId: string,
): AllocationRecord[] {
  return ctx.stores.customerPayments.allocations(paymentId).filter((a) => !a.cancelled);
}

/** 記録済みの入金の未消込残高を、請求書に消し込む */
export const allocateCustomerPayment = defineCommand({
  permission: "payments.manage",
  input: z.object({
    paymentId: idSchema,
    version,
    allocations: z.array(allocationInput).min(1).max(200),
  }),
  run(ctx, { paymentId, version: v, allocations }) {
    const payment = ctx.stores.customerPayments.get(paymentId);
    if (!payment) return err("not_found", "入金が見つかりません");
    if (payment.cancelled) return err("invalid_state", "取り消した入金には消し込めません");
    if (allocations.every((a) => a.amount === 0 && a.adjustment === 0))
      return err("validation", "消し込む金額を入力してください");
    if (!ctx.stores.customerPayments.touch(paymentId, v, meta(ctx))) return conflict();
    const already = activeAllocations(ctx, paymentId).map((a) => a.amount);
    const allocated = allocate(
      ctx,
      payment,
      already.reduce((s, a) => s + a, 0),
      allocations,
    );
    if (!allocated.ok) return allocated;
    ctx.audit.record({
      entityType: "customer_payment",
      entityId: paymentId,
      action: "allocate",
      after: { allocationIds: allocated.value.allocationIds, remaining: allocated.value.remaining },
    });
    return ok({ id: paymentId, ...allocated.value });
  },
});

/** 消込を1件取り消し、請求書の残高と状態を戻す */
function releaseOne(ctx: UsecaseContext, allocation: AllocationRecord): Result<void> {
  const m = meta(ctx);
  if (!ctx.stores.customerPayments.cancelAllocation(allocation.id, allocation.version, m))
    return conflict();
  const invoice = ctx.stores.invoices.get(allocation.invoiceId);
  if (!invoice) return err("not_found", "請求書が見つかりません");
  const next = releaseAllocation(invoice, allocation.amount + allocation.adjustment);
  if (!next.ok) return next;
  // 同じトランザクションで読んだ版番号なので、ここで競合することはない
  ctx.stores.invoices.update(invoice.id, invoice.version, next.value, m);
  ctx.audit.record({
    entityType: "invoice",
    entityId: invoice.id,
    action: "cancel_allocation",
    before: { status: invoice.status, allocated: invoice.allocated },
    after: { ...next.value, allocationId: allocation.id, paymentId: allocation.paymentId },
  });
  return ok(undefined);
}

/** 消込の取消（入金済み → 一部入金・未入金） */
export const cancelAllocationCommand = defineCommand({
  permission: "payments.manage",
  input: z.object({ allocationId: idSchema, version }),
  run(ctx, { allocationId, version: v }) {
    const allocation = ctx.stores.customerPayments.getAllocation(allocationId);
    if (!allocation) return err("not_found", "消込が見つかりません");
    if (allocation.cancelled) return err("invalid_state", "この消込はすでに取り消されています");
    if (allocation.version !== v) return conflict();
    const payment = ctx.stores.customerPayments.get(allocation.paymentId);
    if (!payment) return err("not_found", "入金が見つかりません");
    if (!ctx.stores.customerPayments.touch(payment.id, payment.version, meta(ctx)))
      return conflict();
    const r = releaseOne(ctx, allocation);
    if (!r.ok) return r;
    return ok({ paymentId: payment.id, invoiceId: allocation.invoiceId });
  },
});

/** 入金の取消。有効な消込もまとめて取り消す（請求書は一部入金・未入金に戻る） */
export const cancelCustomerPayment = defineCommand({
  permission: "payments.manage",
  input: z.object({ paymentId: idSchema, version, reason: requiredText(500) }),
  run(ctx, { paymentId, version: v, reason }) {
    const payment = ctx.stores.customerPayments.get(paymentId);
    if (!payment) return err("not_found", "入金が見つかりません");
    const next = cancelPayment(payment);
    if (!next.ok) return next;
    if (!ctx.stores.customerPayments.cancel(paymentId, v, meta(ctx))) return conflict();
    const released = activeAllocations(ctx, paymentId);
    for (const a of released) {
      const r = releaseOne(ctx, a);
      if (!r.ok) return r;
    }
    ctx.audit.record({
      entityType: "customer_payment",
      entityId: paymentId,
      action: "cancel",
      before: { cancelled: false },
      after: { cancelled: true, reason, cancelledAllocationIds: released.map((a) => a.id) },
    });
    return ok({ id: paymentId, cancelledAllocations: released.length });
  },
});

// ---- 照会 -----------------------------------------------------------------------

export interface PaymentListItem extends CustomerPaymentListRow {
  /** 未消込残高 */
  readonly unallocated: number;
}

/** 入金の一覧（入金日の新しい順） */
export const listCustomerPayments = defineQuery({
  permission: "view",
  input: pageInput.extend({
    customerId: z.string().max(64).optional(),
    receivedFrom: optionalBusinessDate,
    receivedTo: optionalBusinessDate,
    unallocated: z.boolean().default(false),
    includeCancelled: z.boolean().default(false),
  }),
  run(ctx, input): Page<PaymentListItem> {
    const result = ctx.stores.customerPayments.list(
      {
        customerId: input.customerId || undefined,
        receivedFrom: input.receivedFrom ?? undefined,
        receivedTo: input.receivedTo ?? undefined,
        unallocatedOnly: input.unallocated,
        includeCancelled: input.includeCancelled,
      },
      input.page,
      input.pageSize,
    );
    return {
      ...result,
      rows: result.rows.map((r) =>
        Object.assign(r, {
          unallocated: r.cancelled ? 0 : paymentUnallocated(r.amount, [r.allocatedAmount]),
        }),
      ),
    };
  },
});

export interface OpenInvoice extends InvoiceRecord {
  readonly outstanding: number;
  readonly overdue: boolean;
}

function openInvoices(
  ctx: Pick<QueryContext, "stores" | "clock">,
  customerId: string,
): OpenInvoice[] {
  const today = ctx.clock.today();
  return ctx.stores.invoices
    .openForCustomer(customerId)
    .map((i) =>
      Object.assign(i, { outstanding: invoiceOutstanding(i), overdue: isOverdue(i, today) }),
    );
}

/** 販売先の、消込の対象にできる請求書（未入金・一部入金。支払期限の早い順） */
export const listOpenInvoices = defineQuery({
  permission: "view",
  input: z.object({ customerId: idSchema }),
  run(ctx, { customerId }): OpenInvoice[] {
    return openInvoices(ctx, customerId);
  },
});

export interface PaymentView {
  readonly payment: CustomerPaymentRecord;
  readonly allocations: readonly AllocationRecord[];
  readonly allocatedAmount: number;
  readonly unallocated: number;
  /** 残りを消し込める請求書（取り消した入金・未消込残高のない入金では空） */
  readonly openInvoices: readonly OpenInvoice[];
}

export const getCustomerPayment = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): PaymentView | null {
    const payment = ctx.stores.customerPayments.get(id);
    if (!payment) return null;
    const allocations = ctx.stores.customerPayments.allocations(id);
    const amounts = allocations.filter((a) => !a.cancelled).map((a) => a.amount);
    const unallocated = payment.cancelled ? 0 : paymentUnallocated(payment.amount, amounts);
    return {
      payment,
      allocations,
      allocatedAmount: amounts.reduce((s, a) => s + a, 0),
      unallocated,
      openInvoices: payment.cancelled ? [] : openInvoices(ctx, payment.customerId),
    };
  },
});

export interface ReceivableItem extends ReceivableRow, Receivable {}

/** 販売先ごとの売掛残高（請求残高・期限超過・入金の未消込残高・差し引きの残高） */
export const listReceivables = defineQuery({
  permission: "view",
  input: pageInput.extend({ customerId: z.string().max(64).optional() }),
  run(ctx, { customerId, page, pageSize }): Page<ReceivableItem> & { today: string } {
    const today = ctx.clock.today();
    const result = ctx.stores.customerPayments.receivables(
      { customerId: customerId || undefined, today },
      page,
      pageSize,
    );
    return { ...result, today, rows: result.rows.map((r) => Object.assign(r, receivable(r))) };
  },
});

export interface ScheduleItem extends InvoiceRecord {
  readonly customerName: string;
  readonly outstanding: number;
  readonly overdue: boolean;
}

/** 入金予定（未入金・一部入金の請求書を支払期限の早い順。期限のないものは最後） */
export const listReceiptSchedule = defineQuery({
  permission: "view",
  input: pageInput.extend({
    customerId: z.string().max(64).optional(),
    overdue: z.boolean().default(false),
    dueTo: optionalBusinessDate,
  }),
  run(ctx, input): Page<ScheduleItem> & { today: string } {
    const today = ctx.clock.today();
    const result = ctx.stores.invoices.list(
      {
        open: true,
        customerId: input.customerId || undefined,
        overdueAsOf: input.overdue ? today : undefined,
        dueTo: input.dueTo ?? undefined,
      },
      "due",
      input.page,
      input.pageSize,
    );
    return {
      ...result,
      today,
      rows: result.rows.map((r) =>
        Object.assign(r, { outstanding: invoiceOutstanding(r), overdue: isOverdue(r, today) }),
      ),
    };
  },
});
