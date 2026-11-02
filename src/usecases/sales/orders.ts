/**
 * 受注（要件定義書 3.8、4章 受注の状態遷移）。登録・編集・分割・取消で引当を更新する。
 * 出荷可能数を超える数量、最低ロット未満、ロットの倍数でない数量は警告だけで、登録はできる。
 */
import { z } from "zod";

import { plannedShipDate } from "../../domain/dates";
import { ratesOn } from "../../domain/money";
import { err, ok, type Result } from "../../domain/result";
import {
  canEditSalesOrder,
  cancelSalesOrder,
  cancelShipment,
  orderAmounts,
  priceReasonRequired,
  validateOrderLines,
  validateSplit,
} from "../../domain/sales";
import { allocationDelta, type AllocationLine } from "../../domain/stock";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE, type UsecaseContext } from "../core";
import {
  businessDate,
  centi,
  idSchema,
  optionalBusinessDate,
  optionalText,
  pageInput,
  quantity,
  requiredText,
  taxCategory,
  version,
  yen,
  type Page,
} from "../schemas";
import { changeAllocation } from "../stock/ledger";
import { evaluateOrder, type OrderEvaluation } from "./evaluate";
import type {
  SalesChargeFields,
  SalesOrderDetail,
  SalesOrderHeader,
  SalesOrderLineFields,
  SalesOrderListRow,
} from "./orders.port";
import type { ShipmentHistoryRow } from "./shipments.port";

const optionalId = z
  .string()
  .max(64)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

const lineInput = z.object({
  itemId: idSchema,
  quantity: z.number({ error: "数量は数字で入力してください" }).pipe(quantity),
  unitPriceCenti: z.number({ error: "単価は小数第2位までの数字で入力してください" }).pipe(centi),
  priceOverrideReason: optionalText(200),
});

const chargeInput = z.object({
  description: requiredText(50),
  quantity: z.number({ error: "数量は数字で入力してください" }).pipe(quantity),
  unitAmount: z.number({ error: "金額は円単位の数字で入力してください" }).pipe(yen),
  taxCategory: taxCategory.default("standard"),
});

const fieldsInput = z.object({
  customerId: z.string().min(1, "販売先を選んでください").max(64),
  orderedOn: businessDate,
  customerContactName: optionalText(100),
  makerDirect: z.boolean().default(false),
  locationId: optionalId,
  employeeId: optionalId,
  deliveryRequestedOn: optionalBusinessDate,
  /** 未入力なら「納品希望日 − 販売先の配送日数」（納品希望日もなければ受注日） */
  shipPlannedOn: optionalBusinessDate,
  memo: optionalText(1000),
  lines: z.array(lineInput).max(300, "1つの受注に入れられる商品は300件までです"),
  charges: z.array(chargeInput).max(20, "送料などは20行までです").default([]),
});

type FieldsInput = z.output<typeof fieldsInput>;

function fieldError(field: string, message: string): Result<never> {
  return err("validation", message, { fields: [{ field, message }] });
}

function meta(ctx: UsecaseContext) {
  return { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId };
}

/** 引当の対象（メーカー直・取消済みは引き当てない） */
function allocationOf(order: {
  readonly makerDirect: boolean;
  readonly locationId: string | null;
  readonly lines: readonly { readonly itemId: string; readonly quantity: number }[];
}): AllocationLine[] {
  const locationId = order.makerDirect ? null : order.locationId;
  return order.lines.map((l) => ({ itemId: l.itemId, locationId, quantity: l.quantity }));
}

/** 見出しの検証（販売先・保管場所・担当者）と、出荷予定日の初期値 */
function header(
  ctx: UsecaseContext,
  input: FieldsInput,
  before: SalesOrderDetail | undefined,
  prefix: string,
): Result<SalesOrderHeader> {
  const customer = ctx.stores.partners.get(input.customerId);
  if (!customer || !customer.isCustomer)
    return fieldError(`${prefix}customerId`, "販売先を選んでください");
  if (customer.archived && before?.customerId !== customer.id)
    return fieldError(`${prefix}customerId`, "取引終了の販売先は選べません");
  const locationId = input.makerDirect ? null : input.locationId;
  if (!input.makerDirect) {
    if (!locationId)
      return fieldError(
        `${prefix}locationId`,
        "出荷元の保管場所を選んでください（メーカー直なら「メーカー直」にチェック）",
      );
    const location = ctx.stores.locations.get(locationId);
    if (!location) return fieldError(`${prefix}locationId`, "保管場所を選んでください");
    if (location.archived && before?.locationId !== locationId)
      return fieldError(`${prefix}locationId`, "取引終了の保管場所は選べません");
  }
  if (input.employeeId && !ctx.stores.employees.get(input.employeeId))
    return fieldError(`${prefix}employeeId`, "担当者を選んでください");
  const shipPlannedOn =
    input.shipPlannedOn ??
    (input.deliveryRequestedOn
      ? plannedShipDate(input.deliveryRequestedOn, customer.deliveryDays)
      : input.orderedOn);
  return ok({
    customerId: input.customerId,
    orderedOn: input.orderedOn,
    customerContactName: input.customerContactName,
    makerDirect: input.makerDirect,
    locationId,
    employeeId: input.employeeId,
    deliveryRequestedOn: input.deliveryRequestedOn,
    shipPlannedOn,
    memo: input.memo,
  });
}

/**
 * 明細を作る。単価と税区分は受注時点の値を写す（保存済みの明細は保存した税区分のまま）。
 * 同じ商品の明細は ID を引き継ぐ（発送後に請求書・返品伝票が明細の ID を指すため、発送前の編集でも変えない）。
 */
function buildLines(
  ctx: UsecaseContext,
  input: FieldsInput,
  before: SalesOrderDetail | undefined,
  prefix: string,
): Result<SalesOrderLineFields[]> {
  const checked = validateOrderLines(input.lines);
  if (!checked.ok) return fieldError(`${prefix}lines`, checked.error.message);
  const items = new Map(
    ctx.stores.items.getMany(input.lines.map((l) => l.itemId)).map((i) => [i.id, i]),
  );
  const saved = new Map((before?.lines ?? []).map((l) => [l.itemId, l]));
  const lines: SalesOrderLineFields[] = [];
  for (const [i, l] of input.lines.entries()) {
    const item = items.get(l.itemId);
    if (!item)
      return fieldError(`${prefix}lines.${i}.itemId`, "登録されていない商品が含まれています");
    const savedLine = saved.get(l.itemId);
    if (item.discontinued && !savedLine)
      return fieldError(`${prefix}lines.${i}.itemId`, `「${item.name}」は取扱終了の商品です`);
    if (
      priceReasonRequired({
        unitPriceCenti: l.unitPriceCenti,
        listPriceCenti: item.salesPriceCenti,
        previousPriceCenti: savedLine?.unitPriceCenti ?? null,
        reason: l.priceOverrideReason,
      })
    ) {
      return fieldError(
        `${prefix}lines.${i}.priceOverrideReason`,
        `「${item.name}」の単価を卸単価から変えた理由を入力してください`,
      );
    }
    lines.push({
      id: savedLine?.id ?? ctx.ids.next(),
      itemId: l.itemId,
      quantity: l.quantity,
      unitPriceCenti: l.unitPriceCenti,
      // 卸単価のままなら理由は残さない
      priceOverrideReason: l.unitPriceCenti === item.salesPriceCenti ? null : l.priceOverrideReason,
      taxCategory: savedLine?.taxCategory ?? item.taxCategory,
      memo: savedLine?.memo ?? null,
    });
  }
  return ok(lines);
}

function buildCharges(ctx: UsecaseContext, input: FieldsInput): SalesChargeFields[] {
  return input.charges.map((c) => ({
    id: ctx.ids.next(),
    description: c.description,
    quantity: c.quantity,
    unitAmount: c.unitAmount,
    taxCategory: c.taxCategory,
    memo: null,
  }));
}

export const createSalesOrder = defineCommand({
  permission: "salesOrders.manage",
  input: fieldsInput,
  run(ctx, input) {
    const head = header(ctx, input, undefined, "");
    if (!head.ok) return head;
    const lines = buildLines(ctx, input, undefined, "");
    if (!lines.ok) return lines;
    const charges = buildCharges(ctx, input);
    const id = ctx.ids.next();
    const number = ctx.sequences.next("salesOrder", input.orderedOn);
    ctx.stores.salesOrders.insert(
      { id, number, status: "received", splitFromId: null, ...head.value },
      lines.value,
      charges,
      meta(ctx),
    );
    const allocated = changeAllocation(
      ctx,
      allocationDelta([], allocationOf({ ...head.value, lines: lines.value })),
    );
    if (!allocated.ok) return allocated;
    ctx.audit.record({
      entityType: "sales_order",
      entityId: id,
      action: "create",
      after: { number, ...head.value, lines: lines.value, charges },
    });
    return ok({ id, number });
  },
});

export const updateSalesOrder = defineCommand({
  permission: "salesOrders.manage",
  input: z.object({ id: idSchema, version, fields: fieldsInput }),
  run(ctx, { id, version: v, fields }) {
    const before = ctx.stores.salesOrders.get(id);
    if (!before) return err("not_found", "受注が見つかりません");
    if (!canEditSalesOrder(before.status))
      return err("invalid_state", "発送前（受注済み）の受注だけを編集できます");
    const head = header(ctx, fields, before, "fields.");
    if (!head.ok) return head;
    const lines = buildLines(ctx, fields, before, "fields.");
    if (!lines.ok) return lines;
    const charges = buildCharges(ctx, fields);
    if (!ctx.stores.salesOrders.update(id, v, head.value, meta(ctx)))
      return err("conflict", STALE_VERSION_MESSAGE);
    ctx.stores.salesOrders.replaceLines(id, lines.value);
    ctx.stores.salesOrders.replaceCharges(id, charges);
    // 旧明細（旧保管場所）の引当を外し、新明細（新保管場所）の引当を加える
    const allocated = changeAllocation(
      ctx,
      allocationDelta(allocationOf(before), allocationOf({ ...head.value, lines: lines.value })),
    );
    if (!allocated.ok) return allocated;
    ctx.audit.record({
      entityType: "sales_order",
      entityId: id,
      action: "update",
      before,
      after: { ...head.value, lines: lines.value, charges },
    });
    return ok({ id });
  },
});

export const cancelSalesOrderCommand = defineCommand({
  permission: "salesOrders.manage",
  input: z.object({ id: idSchema, version, reason: requiredText(500) }),
  run(ctx, { id, version: v, reason }) {
    const before = ctx.stores.salesOrders.get(id);
    if (!before) return err("not_found", "受注が見つかりません");
    const next = cancelSalesOrder(before.status);
    if (!next.ok) return next;
    if (
      !ctx.stores.salesOrders.update(id, v, { status: next.value, cancelReason: reason }, meta(ctx))
    )
      return err("conflict", STALE_VERSION_MESSAGE);
    const released = changeAllocation(ctx, allocationDelta(allocationOf(before), []));
    if (!released.ok) return released;
    ctx.audit.record({
      entityType: "sales_order",
      entityId: id,
      action: "cancel",
      before: { status: before.status },
      after: { status: next.value, reason },
    });
    return ok({ id });
  },
});

/**
 * 受注の分割（一部だけ先に発送する場合）。指定した明細・数量を新しい受注に移す。
 * 送料などは元の受注に残す。保管場所は同じなので引当の合計は変わらない。
 */
export const splitSalesOrder = defineCommand({
  permission: "salesOrders.manage",
  input: z.object({
    id: idSchema,
    version,
    moves: z
      .array(
        z.object({
          lineId: idSchema,
          quantity: z
            .number({ error: "数量は数字で入力してください" })
            .int("整数で入力してください"),
        }),
      )
      .max(300),
    /** 新しい受注の出荷予定日（未入力なら元の受注と同じ） */
    shipPlannedOn: optionalBusinessDate,
  }),
  run(ctx, { id, version: v, moves, shipPlannedOn }) {
    const before = ctx.stores.salesOrders.get(id);
    if (!before) return err("not_found", "受注が見つかりません");
    if (!canEditSalesOrder(before.status))
      return err("invalid_state", "発送前（受注済み）の受注だけを分割できます");
    const plan = validateSplit(before.lines, new Map(moves.map((m) => [m.lineId, m.quantity])));
    if (!plan.ok) return plan;
    const kept: SalesOrderLineFields[] = [];
    const moved: SalesOrderLineFields[] = [];
    for (const { line, keep, move } of plan.value) {
      const fields = {
        itemId: line.itemId,
        unitPriceCenti: line.unitPriceCenti,
        priceOverrideReason: line.priceOverrideReason,
        taxCategory: line.taxCategory,
        memo: line.memo,
      };
      if (keep > 0) kept.push({ id: line.id, quantity: keep, ...fields });
      if (move > 0) moved.push({ id: ctx.ids.next(), quantity: move, ...fields });
    }
    if (!ctx.stores.salesOrders.update(id, v, {}, meta(ctx)))
      return err("conflict", STALE_VERSION_MESSAGE);
    ctx.stores.salesOrders.replaceLines(id, kept);
    const newId = ctx.ids.next();
    const number = ctx.sequences.next("salesOrder", before.orderedOn);
    const head: SalesOrderHeader = {
      customerId: before.customerId,
      orderedOn: before.orderedOn,
      customerContactName: before.customerContactName,
      makerDirect: before.makerDirect,
      locationId: before.locationId,
      employeeId: before.employeeId,
      deliveryRequestedOn: before.deliveryRequestedOn,
      shipPlannedOn: shipPlannedOn ?? before.shipPlannedOn,
      memo: before.memo,
    };
    ctx.stores.salesOrders.insert(
      { id: newId, number, status: "received", splitFromId: id, ...head },
      moved,
      [],
      meta(ctx),
    );
    // 引当：新しい受注は元の受注と同じ保管場所なので、商品×保管場所ごとの引当の合計は変わらない
    // （残す数 + 移す数 = 元の数。allocationDelta の差分は 0 になるので、集計表は更新しない）
    ctx.audit.record({
      entityType: "sales_order",
      entityId: id,
      action: "split",
      before: { lines: before.lines.map((l) => ({ id: l.id, quantity: l.quantity })) },
      after: { lines: kept.map((l) => ({ id: l.id, quantity: l.quantity })), splitTo: newId },
    });
    ctx.audit.record({
      entityType: "sales_order",
      entityId: newId,
      action: "create_by_split",
      after: { number, splitFromId: id, ...head, lines: moved },
    });
    return ok({ id: newId, number });
  },
});

// ---- 照会 -----------------------------------------------------------------------

const statusInput = z.enum(["received", "shipped", "cancelled"]);

const listFilterInput = {
  status: statusInput.optional(),
  customerId: z.string().max(64).optional(),
  locationId: z.string().max(64).optional(),
  shipFrom: optionalBusinessDate,
  shipTo: optionalBusinessDate,
  q: z.string().trim().max(100).optional(),
  shortage: z.boolean().default(false),
};

export interface SalesOrderListItem extends SalesOrderListRow {
  /** 税込の合計（受注日の税率）。税率が設定されていなければ null */
  readonly total: number | null;
  readonly subtotal: number;
}

/** 受注一覧（状態・販売先・出荷予定日・保管場所・キーワード・出荷可能数不足で絞り込む） */
export const listSalesOrders = defineQuery({
  permission: "view",
  input: pageInput.extend(listFilterInput),
  run(ctx, { page, pageSize, shipFrom, shipTo, ...filter }): Page<SalesOrderListItem> {
    const result = ctx.stores.salesOrders.list(
      { ...filter, shipFrom: shipFrom ?? undefined, shipTo: shipTo ?? undefined },
      page,
      pageSize,
    );
    const sources = ctx.stores.salesOrders.amountSources(result.rows.map((r) => r.id));
    const taxRates = ctx.stores.settings.listTaxRates();
    const mode = ctx.stores.settings.getCompany().roundingMode;
    const rows = result.rows.map((r): SalesOrderListItem => {
      const rates = ratesOn(taxRates, r.orderedOn);
      const amounts = orderAmounts(
        sources.lines.filter((l) => l.salesOrderId === r.id),
        sources.charges.filter((c) => c.salesOrderId === r.id),
        rates ?? { standard: 0, reduced: 0 },
        mode,
      );
      return {
        ...r,
        subtotal: amounts.summary.subtotal,
        total: rates ? amounts.summary.total : null,
      };
    });
    return { ...result, rows };
  },
});

export interface SalesOrderView {
  readonly order: SalesOrderDetail;
  readonly evaluation: OrderEvaluation;
  readonly shipments: readonly (ShipmentHistoryRow & {
    /** 発送を取り消せるか（状態と請求書の有無。権限は画面で判定する） */
    readonly cancellable: boolean;
  })[];
  /** 状態から決まる、できる操作（権限は画面で判定する） */
  readonly actions: {
    readonly edit: boolean;
    readonly ship: boolean;
    readonly cancel: boolean;
    readonly split: boolean;
  };
}

/** 受注詳細（明細の金額・出荷可能数・警告、発送の履歴と納品書） */
export const getSalesOrder = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): SalesOrderView | null {
    const order = ctx.stores.salesOrders.get(id);
    if (!order) return null;
    const open = canEditSalesOrder(order.status);
    const evaluation = evaluateOrder(ctx, {
      existing: order,
      date: order.orderedOn,
      makerDirect: order.makerDirect,
      locationId: order.locationId,
      lines: order.lines,
      charges: order.charges,
      withStock: open,
    });
    const hasReturns = ctx.stores.salesReturns.hasActive(id);
    const shipments = ctx.stores.shipments
      .historyFor(id)
      .map((s): SalesOrderView["shipments"][number] =>
        Object.assign(s, {
          cancellable:
            !s.cancelled && cancelShipment(order.status, s.invoiceId !== null, hasReturns).ok,
        }),
      );
    return {
      order,
      evaluation,
      shipments,
      actions: {
        edit: open,
        ship: open && order.lines.length > 0,
        cancel: open,
        split: open && order.lines.reduce((s, l) => s + l.quantity, 0) > 1,
      },
    };
  },
});

const draftNumber = z.number().nullable();

/**
 * 受注の作成・編集の画面で、明細と合計を計算し直す（入力の途中でも計算できるよう、数量・単価は null を許す）。
 */
export const previewSalesOrder = defineQuery({
  permission: "view",
  input: z.object({
    orderId: z.string().max(64).nullable().default(null),
    orderedOn: z.string().max(10),
    makerDirect: z.boolean().default(false),
    locationId: z.string().max(64).nullable().default(null),
    lines: z
      .array(
        z.object({
          itemId: idSchema,
          quantity: draftNumber,
          unitPriceCenti: draftNumber,
          priceOverrideReason: z.string().max(200).nullable().default(null),
        }),
      )
      .max(300),
    charges: z
      .array(
        z.object({
          description: z.string().max(50),
          quantity: draftNumber,
          unitAmount: draftNumber,
          taxCategory: taxCategory.default("standard"),
        }),
      )
      .max(20)
      .default([]),
  }),
  run(ctx, input): OrderEvaluation {
    const existing = input.orderId ? ctx.stores.salesOrders.get(input.orderId) : undefined;
    return evaluateOrder(ctx, {
      existing,
      date: businessDate.safeParse(input.orderedOn).success ? input.orderedOn : ctx.clock.today(),
      makerDirect: input.makerDirect,
      locationId: input.locationId,
      lines: input.lines,
      charges: input.charges,
      withStock: existing === undefined || canEditSalesOrder(existing.status),
    });
  },
});

/** 出荷予定日の初期値 = 納品希望日 − 販売先の配送日数（納品希望日がなければ受注日） */
export const defaultShipDate = defineQuery({
  permission: "view",
  input: z.object({
    customerId: z.string().max(64).default(""),
    deliveryRequestedOn: optionalBusinessDate,
    orderedOn: optionalBusinessDate,
  }),
  run(ctx, { customerId, deliveryRequestedOn, orderedOn }): string {
    if (!deliveryRequestedOn) return orderedOn ?? ctx.clock.today();
    const customer = customerId ? ctx.stores.partners.get(customerId) : undefined;
    return plannedShipDate(deliveryRequestedOn, customer?.deliveryDays ?? 0);
  },
});
