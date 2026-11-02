/**
 * 請求書（要件定義書 3.10、4章 請求書の状態遷移）。
 * - 締め日のない販売先は発送ごとに発行し、締め日のある販売先は締め処理で締め期間内の未請求の発送をまとめて発行する（繰越なし）
 * - 発行で明細・金額・宛名・自社情報を保存し、対象の発送と未請求の返品伝票（マイナスの明細）を請求書に結びつけ、帳票を発行する
 * - 取消は消込がないときだけ（理由が必須）。対象の発送と返品伝票は未請求に戻り、帳票は取消済みになる
 * - 再発行は取消と同時に、同じ発送・返品伝票で新しい番号の請求書を発行する（元の請求書を reissued_from_id で指す）
 */
import { z } from "zod";

import {
  closingDueDate,
  closingTarget,
  invoiceOutstanding,
  isOpenInvoice,
  isOverdue,
  issuedInvoiceStatus,
  planInvoice,
  validateClosing,
  validateIssueDates,
  type InvoiceLineDraft,
  type InvoiceReturnSource,
  type InvoiceShipmentSource,
} from "../../domain/billing";
import type { TaxSummary } from "../../domain/money";
import { err, ok, type Result } from "../../domain/result";
import { cancelInvoice } from "../../domain/sales";
import {
  defineCommand,
  defineQuery,
  STALE_VERSION_MESSAGE,
  type QueryContext,
  type UsecaseContext,
} from "../core";
import type { PartnerRecord } from "../masters/partners.port";
import type { UnbilledShipment } from "../sales/shipments.port";
import {
  businessDate,
  idSchema,
  optionalBusinessDate,
  pageInput,
  requiredText,
  version,
  type Page,
} from "../schemas";
import type { InvoiceDetail, InvoiceDocumentRef, InvoiceListRow } from "./invoices.port";
import type { SalesReturnRecord } from "./returns.port";
import {
  buildInvoiceSnapshot,
  issuerOf,
  recipientOf,
  type SnapshotDelivery,
  type SnapshotReturn,
} from "./snapshots";

/** 1つの販売先の1回の締め処理・1つの請求書で扱う発送・返品伝票の上限 */
const MAX_SOURCES = 500;

function meta(ctx: Pick<UsecaseContext, "clock" | "actor">) {
  return { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId };
}

function conflict(prefix = ""): Result<never> {
  return err("conflict", `${prefix}${STALE_VERSION_MESSAGE}`);
}

// ---- 請求書の元になる発送・返品伝票 ------------------------------------------------------

type ShipmentSource = InvoiceShipmentSource & {
  readonly lines: readonly (InvoiceShipmentSource["lines"][number] & {
    readonly itemCode: string;
  })[];
};

function shipmentSource(s: UnbilledShipment): ShipmentSource {
  return {
    shipmentId: s.shipmentId,
    shippedOn: s.shippedOn,
    lines: s.lines.map((l) => ({
      salesOrderLineId: l.salesOrderLineId,
      itemCode: l.itemCode,
      itemName: l.itemName,
      unitName: l.salesUnitName,
      quantity: l.quantity,
      unitPriceCenti: l.unitPriceCenti,
      taxCategory: l.taxCategory,
    })),
    charges: s.charges,
  };
}

type ReturnSource = InvoiceReturnSource & {
  readonly lines: readonly (InvoiceReturnSource["lines"][number] & { readonly itemCode: string })[];
};

function returnSource(r: SalesReturnRecord): ReturnSource {
  return {
    salesReturnId: r.id,
    returnedOn: r.returnedOn,
    lines: r.lines.map((l) => ({
      salesReturnLineId: l.id,
      itemCode: l.itemCode,
      itemName: l.itemName,
      unitName: l.unitName,
      quantity: l.quantity,
      unitPriceCenti: l.unitPriceCenti,
      amount: l.amount,
      taxCategory: l.taxCategory,
    })),
  };
}

function lineKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

/** 計算した明細を、帳票の発送ごと・返品伝票ごとのまとまりにする */
function snapshotGroups(
  shipments: readonly UnbilledShipment[],
  returns: readonly SalesReturnRecord[],
  lines: readonly InvoiceLineDraft[],
): { deliveries: SnapshotDelivery[]; returns: SnapshotReturn[] } {
  const byKey = new Map(lines.map((l) => [lineKey(l.sourceType, l.sourceId), l]));
  const pick = (sourceType: string, sourceId: string, itemCode: string | null) => {
    const line = byKey.get(lineKey(sourceType, sourceId));
    return line ? [{ itemCode, line }] : [];
  };
  return {
    deliveries: shipments.map((s) => ({
      shippedOn: s.shippedOn,
      deliveryNoteNumber: s.deliveryNoteNumber,
      salesOrderNumber: s.salesOrderNumber,
      lines: [
        ...s.lines.flatMap((l) => pick("shipment_line", l.salesOrderLineId, l.itemCode)),
        ...s.charges.flatMap((c) => pick("charge", c.salesChargeId, null)),
      ],
    })),
    returns: returns.map((r) => ({
      returnedOn: r.returnedOn,
      number: r.number,
      salesOrderNumber: r.salesOrderNumber,
      lines: r.lines.flatMap((l) => pick("return_line", l.id, l.itemCode)),
    })),
  };
}

/** 請求書の明細と金額の見積もり（発行の前に画面に出す。発行と同じ domain の計算） */
export interface InvoicePreview {
  readonly lines: readonly InvoiceLineDraft[];
  readonly summary: TaxSummary;
  readonly lastTransactionDate: string;
}

function preview(
  ctx: Pick<QueryContext, "stores">,
  shipments: readonly UnbilledShipment[],
  returns: readonly SalesReturnRecord[],
): Result<InvoicePreview> {
  return planInvoice({
    shipments: shipments.map(shipmentSource),
    returns: returns.map(returnSource),
    taxRates: ctx.stores.settings.listTaxRates(),
    mode: ctx.stores.settings.getCompany().roundingMode,
  });
}

export interface IssuedInvoice {
  readonly id: string;
  readonly number: string;
  readonly documentId: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly total: number;
}

/** 請求書を発行する（発送ごと・締め処理・再発行で共通） */
function issueInvoice(
  ctx: UsecaseContext,
  a: {
    readonly customer: PartnerRecord;
    readonly shipments: readonly UnbilledShipment[];
    readonly returns: readonly SalesReturnRecord[];
    readonly issuedOn: string;
    readonly dueOn: string | null;
    readonly periodFrom: string | null;
    readonly periodTo: string | null;
    readonly reissuedFrom: { readonly id: string; readonly number: string } | null;
  },
): Result<IssuedInvoice> {
  const name = a.customer.name;
  const company = ctx.stores.settings.getCompany();
  const plan = preview(ctx, a.shipments, a.returns);
  if (!plan.ok) return err(plan.error.code, `${name}：${plan.error.message}`);
  const dates = validateIssueDates({
    issuedOn: a.issuedOn,
    dueOn: a.dueOn,
    lastTransactionDate: plan.value.lastTransactionDate,
  });
  if (!dates.ok) return dates;
  const { summary, lines } = plan.value;
  const id = ctx.ids.next();
  const number = ctx.sequences.next("invoice", a.issuedOn);
  const m = meta(ctx);
  ctx.stores.invoices.insert(
    {
      id,
      number,
      customerId: a.customer.id,
      issuedOn: a.issuedOn,
      periodFrom: a.periodFrom,
      periodTo: a.periodTo,
      dueOn: a.dueOn,
      subtotal: summary.subtotal,
      tax: summary.tax,
      total: summary.total,
      taxSummary: summary.groups.map((g) => ({ ...g })),
      roundingMode: company.roundingMode,
      recipientSnapshot: recipientOf(a.customer),
      issuerSnapshot: issuerOf(company),
      allocated: 0,
      status: issuedInvoiceStatus(summary.total),
      reissuedFromId: a.reissuedFrom?.id ?? null,
      cancelReason: null,
    },
    lines.map((l) => ({ id: ctx.ids.next(), ...l })),
    m,
  );
  const shipmentRefs = a.shipments.map((s) => ({ id: s.shipmentId, version: s.shipmentVersion }));
  if (ctx.stores.invoices.attachShipments(id, shipmentRefs, m) !== shipmentRefs.length)
    return conflict(`${name}：`);
  const returnRefs = a.returns.map((r) => ({ id: r.id, version: r.version }));
  if (ctx.stores.invoices.attachReturns(id, returnRefs, m) !== returnRefs.length)
    return conflict(`${name}：`);
  const groups = snapshotGroups(a.shipments, a.returns, lines);
  const snapshot = buildInvoiceSnapshot({
    number,
    issuedOn: a.issuedOn,
    periodFrom: a.periodFrom,
    periodTo: a.periodTo,
    dueOn: a.dueOn,
    company,
    customer: a.customer,
    deliveries: groups.deliveries,
    returns: groups.returns,
    summary,
    roundingMode: company.roundingMode,
    reissuedFromNumber: a.reissuedFrom?.number ?? null,
  });
  const documentId = ctx.documents.issue({
    documentType: "invoice",
    number,
    entityId: id,
    partnerId: a.customer.id,
    transactionDate: a.issuedOn,
    amount: summary.total,
    snapshot,
  });
  ctx.audit.record({
    entityType: "invoice",
    entityId: id,
    action: a.reissuedFrom ? "reissue" : "issue",
    after: {
      number,
      customerId: a.customer.id,
      issuedOn: a.issuedOn,
      periodFrom: a.periodFrom,
      periodTo: a.periodTo,
      dueOn: a.dueOn,
      subtotal: summary.subtotal,
      tax: summary.tax,
      total: summary.total,
      shipmentIds: shipmentRefs.map((s) => s.id),
      salesReturnIds: returnRefs.map((r) => r.id),
      reissuedFromId: a.reissuedFrom?.id ?? null,
    },
  });
  return ok({
    id,
    number,
    documentId,
    customerId: a.customer.id,
    customerName: name,
    total: summary.total,
  });
}

function customerOf(ctx: Pick<QueryContext, "stores">, id: string): Result<PartnerRecord> {
  const customer = ctx.stores.partners.get(id);
  if (!customer || !customer.isCustomer) return err("not_found", "販売先が見つかりません");
  return ok(customer);
}

/** 締め日の取引条件（締め日・支払月・支払日はそろって入力されている） */
function termsOf(customer: PartnerRecord) {
  if (
    customer.closingDay === null ||
    customer.paymentMonthOffset === null ||
    customer.paymentDay === null
  )
    return null;
  return {
    closingDay: customer.closingDay,
    paymentMonthOffset: customer.paymentMonthOffset,
    paymentDay: customer.paymentDay,
  };
}

const refInput = z.object({ id: idSchema, version });

/** 未請求の返品伝票を、画面で選んだ版番号のまま読む */
function loadReturns(
  ctx: UsecaseContext,
  customerId: string,
  refs: readonly { readonly id: string; readonly version: number }[],
): Result<SalesReturnRecord[]> {
  const found = ctx.stores.salesReturns.getMany(refs.map((r) => r.id));
  const byId = new Map(found.map((r) => [r.id, r]));
  const out: SalesReturnRecord[] = [];
  for (const ref of refs) {
    const r = byId.get(ref.id);
    if (!r || r.customerId !== customerId)
      return err("validation", "対象外の返品伝票が含まれています");
    if (r.cancelled || r.invoiceId !== null)
      return err(
        "conflict",
        `返品伝票 ${r.number} はすでに請求書に載っているか、取り消されています`,
      );
    if (r.version !== ref.version) return conflict();
    out.push(r);
  }
  return ok(
    out.toSorted(
      (a, b) => a.returnedOn.localeCompare(b.returnedOn) || a.number.localeCompare(b.number),
    ),
  );
}

// ---- 発送ごとの発行 -------------------------------------------------------------------

/** 締め日のない販売先の、発送ごとの請求書の発行（未請求の返品伝票は選んだものをマイナスの明細にする） */
export const issueInvoiceCommand = defineCommand({
  permission: "invoices.manage",
  input: z.object({
    shipmentId: idSchema,
    version,
    returns: z.array(refInput).max(100).default([]),
    issuedOn: businessDate,
    dueOn: optionalBusinessDate,
  }),
  run(ctx, input) {
    const shipment = ctx.stores.shipments.get(input.shipmentId);
    if (!shipment) return err("not_found", "発送が見つかりません");
    if (shipment.cancelled) return err("invalid_state", "取り消した発送です");
    if (shipment.invoiceId !== null)
      return err("invalid_state", "この発送はすでに請求書に載っています");
    if (shipment.version !== input.version) return conflict();
    const order = ctx.stores.salesOrders.get(shipment.salesOrderId);
    if (!order) return err("not_found", "受注が見つかりません");
    const customer = customerOf(ctx, order.customerId);
    if (!customer.ok) return customer;
    if (termsOf(customer.value)) {
      return err("invalid_state", "締め日のある販売先の請求書は、締め処理でまとめて発行します");
    }
    const source = ctx.stores.shipments
      .unbilled(
        {
          customerId: order.customerId,
          shippedFrom: shipment.shippedOn,
          shippedTo: shipment.shippedOn,
        },
        2000,
      )
      .find((s) => s.shipmentId === shipment.id);
    if (!source) return conflict();
    const returns = loadReturns(ctx, order.customerId, input.returns);
    if (!returns.ok) return returns;
    return issueInvoice(ctx, {
      customer: customer.value,
      shipments: [source],
      returns: returns.value,
      issuedOn: input.issuedOn,
      dueOn: input.dueOn,
      periodFrom: null,
      periodTo: null,
      reissuedFrom: null,
    });
  },
});

// ---- 締め処理 -------------------------------------------------------------------------

function sameRefs(
  a: readonly { readonly id: string; readonly version: number }[],
  b: readonly { readonly id: string; readonly version: number }[],
): boolean {
  if (a.length !== b.length) return false;
  const versions = new Map(a.map((r) => [r.id, r.version]));
  return b.every((r) => versions.get(r.id) === r.version);
}

/**
 * 締め処理（月締めの販売先の請求書の一括発行）。選んだ販売先ごとに、締め期間内の未請求の発送と、
 * 締め日までの未請求の返品伝票をまとめて1枚の請求書にする。1つのトランザクションで処理し、
 * 1件でも発行できなければ何も発行しない。画面を開いた後に発送・返品が変わった販売先があれば conflict。
 * 発行日は指定がなければ締め日、支払期限は取引条件から計算する。
 */
export const closeInvoices = defineCommand({
  permission: "invoices.manage",
  input: z.object({
    issuedOn: optionalBusinessDate,
    targets: z
      .array(
        z.object({
          customerId: idSchema,
          periodFrom: businessDate,
          periodTo: businessDate,
          shipments: z.array(refInput).min(1).max(MAX_SOURCES),
          returns: z.array(refInput).max(MAX_SOURCES).default([]),
        }),
      )
      .min(1, "締め処理する販売先を選んでください")
      .max(200, "一度に締め処理できるのは200件までです"),
  }),
  run(ctx, { issuedOn, targets }) {
    const seen = new Set<string>();
    const issued: IssuedInvoice[] = [];
    for (const t of targets) {
      if (seen.has(t.customerId)) return err("validation", "同じ販売先が複数含まれています");
      seen.add(t.customerId);
      const customer = customerOf(ctx, t.customerId);
      if (!customer.ok) return customer;
      const name = customer.value.name;
      const terms = termsOf(customer.value);
      if (!terms) return err("invalid_state", `${name}：締め日が設定されていない販売先です`);
      const shipments = ctx.stores.shipments.unbilled(
        { customerId: t.customerId, shippedFrom: t.periodFrom, shippedTo: t.periodTo },
        MAX_SOURCES + 1,
      );
      const returns = ctx.stores.salesReturns.unbilled(
        { customerId: t.customerId, returnedTo: t.periodTo },
        MAX_SOURCES + 1,
      );
      const checked = validateClosing({
        closingDay: terms.closingDay,
        periodFrom: t.periodFrom,
        periodTo: t.periodTo,
        today: ctx.clock.today(),
        shippedOn: shipments.map((s) => s.shippedOn),
        returnedOn: returns.map((r) => r.returnedOn),
      });
      if (!checked.ok) return err(checked.error.code, `${name}：${checked.error.message}`);
      if (
        !sameRefs(
          t.shipments,
          shipments.map((s) => ({ id: s.shipmentId, version: s.shipmentVersion })),
        ) ||
        !sameRefs(t.returns, returns)
      ) {
        return err(
          "conflict",
          `${name}：締め処理の画面を開いた後に発送・返品が変わりました。画面を開き直してください`,
        );
      }
      const r = issueInvoice(ctx, {
        customer: customer.value,
        shipments,
        returns,
        issuedOn: issuedOn ?? t.periodTo,
        dueOn: closingDueDate(t.periodTo, terms),
        periodFrom: t.periodFrom,
        periodTo: t.periodTo,
        reissuedFrom: null,
      });
      if (!r.ok) return r;
      issued.push(r.value);
    }
    return ok({ issued });
  },
});

// ---- 取消と再発行 -------------------------------------------------------------------

function cancelExisting(
  ctx: UsecaseContext,
  invoice: InvoiceDetail,
  expectedVersion: number,
  reason: string,
  action: "cancel" | "cancel_for_reissue",
): Result<{ shipmentIds: string[]; returnIds: string[] }> {
  const next = cancelInvoice(invoice.status, invoice.allocated);
  if (!next.ok) return next;
  if (invoice.allocations.some((a) => !a.cancelled))
    return err(
      "invalid_state",
      "入金の消込がある請求書は取り消せません。先に消込を取り消してください",
    );
  const m = meta(ctx);
  if (
    !ctx.stores.invoices.update(
      invoice.id,
      expectedVersion,
      { status: next.value, cancelReason: reason },
      m,
    )
  )
    return conflict();
  const shipmentIds = ctx.stores.invoices.detachShipments(invoice.id, m);
  const returnIds = ctx.stores.invoices.detachReturns(invoice.id, m);
  for (const documentId of ctx.stores.documents.latestForEntities("invoice", [invoice.id]))
    ctx.documents.cancel(documentId);
  ctx.audit.record({
    entityType: "invoice",
    entityId: invoice.id,
    action,
    before: { status: invoice.status },
    after: { status: next.value, reason, shipmentIds, salesReturnIds: returnIds },
  });
  return ok({ shipmentIds, returnIds });
}

const cancelInput = z.object({ id: idSchema, version, reason: requiredText(500) });

/** 請求書の取消（消込がないときだけ）。対象の発送・返品伝票は未請求に戻り、帳票は取消済みになる */
export const cancelInvoiceCommand = defineCommand({
  permission: "invoices.manage",
  input: cancelInput,
  run(ctx, { id, version: v, reason }) {
    const invoice = ctx.stores.invoices.get(id);
    if (!invoice) return err("not_found", "請求書が見つかりません");
    const r = cancelExisting(ctx, invoice, v, reason, "cancel");
    if (!r.ok) return r;
    return ok({ id, ...r.value });
  },
});

/**
 * 取消と再発行。請求書を取り消し、同じ発送・返品伝票で新しい番号の請求書を発行する
 * （宛名・自社情報・端数処理は今の設定で作り直す）。発行日は指定がなければ元の請求書と同じ日、
 * 支払期限は月締めなら取引条件から計算し、発送ごとなら指定の日（なければ元の請求書と同じ日）。
 */
export const reissueInvoice = defineCommand({
  permission: "invoices.manage",
  input: cancelInput.extend({ issuedOn: optionalBusinessDate, dueOn: optionalBusinessDate }),
  run(ctx, { id, version: v, reason, issuedOn, dueOn }) {
    const invoice = ctx.stores.invoices.get(id);
    if (!invoice) return err("not_found", "請求書が見つかりません");
    const customer = customerOf(ctx, invoice.customerId);
    if (!customer.ok) return customer;
    const cancelled = cancelExisting(ctx, invoice, v, reason, "cancel_for_reissue");
    if (!cancelled.ok) return cancelled;
    const ids = new Set(cancelled.value.shipmentIds);
    const dates = invoice.shipments.map((s) => s.shippedOn).toSorted();
    const shipments = ctx.stores.shipments
      .unbilled(
        { customerId: invoice.customerId, shippedFrom: dates[0], shippedTo: dates.at(-1) },
        2000,
      )
      .filter((s) => ids.has(s.shipmentId));
    if (shipments.length !== ids.size || shipments.length === 0) return conflict();
    const returns = ctx.stores.salesReturns
      .getMany(cancelled.value.returnIds)
      .toSorted(
        (a, b) => a.returnedOn.localeCompare(b.returnedOn) || a.number.localeCompare(b.number),
      );
    const terms = termsOf(customer.value);
    const due =
      invoice.periodTo !== null && terms
        ? closingDueDate(invoice.periodTo, terms)
        : (dueOn ?? invoice.dueOn);
    return issueInvoice(ctx, {
      customer: customer.value,
      shipments,
      returns,
      issuedOn: issuedOn ?? invoice.issuedOn,
      dueOn: due,
      periodFrom: invoice.periodFrom,
      periodTo: invoice.periodTo,
      reissuedFrom: { id: invoice.id, number: invoice.number },
    });
  },
});

// ---- 照会 -----------------------------------------------------------------------

const statusInput = z.enum(["unpaid", "partial", "paid", "cancelled", "open"]);

export interface InvoiceListItem extends InvoiceListRow {
  readonly outstanding: number;
  readonly overdue: boolean;
}

function listItem(row: InvoiceListRow, today: string): InvoiceListItem {
  return { ...row, outstanding: invoiceOutstanding(row), overdue: isOverdue(row, today) };
}

/** 請求書一覧（状態・販売先・発行日・支払期限超過・番号・送付の失敗で絞り込む。発行日の新しい順） */
export const listInvoices = defineQuery({
  permission: "view",
  input: pageInput.extend({
    status: statusInput.optional(),
    customerId: z.string().max(64).optional(),
    issuedFrom: optionalBusinessDate,
    issuedTo: optionalBusinessDate,
    overdue: z.boolean().default(false),
    q: z.string().trim().max(50).optional(),
    sendFailed: z.boolean().default(false),
  }),
  run(ctx, input): Page<InvoiceListItem> {
    const today = ctx.clock.today();
    const status = input.status === "open" ? undefined : input.status;
    const result = ctx.stores.invoices.list(
      {
        status,
        open: input.status === "open",
        customerId: input.customerId || undefined,
        issuedFrom: input.issuedFrom ?? undefined,
        issuedTo: input.issuedTo ?? undefined,
        overdueAsOf: input.overdue ? today : undefined,
        number: input.q || undefined,
        sendStatus: input.sendFailed ? "failed" : undefined,
      },
      "issued",
      input.page,
      input.pageSize,
    );
    return { ...result, rows: result.rows.map((r) => listItem(r, today)) };
  },
});

export interface InvoiceView {
  readonly invoice: InvoiceDetail;
  readonly outstanding: number;
  readonly overdue: boolean;
  /** 月締め（締め期間あり）か、発送ごとか */
  readonly kind: "closing" | "per_shipment";
  /** 状態から決まる、できる操作（権限は画面で判定する） */
  readonly actions: {
    readonly cancel: boolean;
    readonly allocate: boolean;
  };
  /** 取り消せない理由 */
  readonly cancelBlocker: string | null;
  readonly document: InvoiceDocumentRef | null;
}

/** 請求書詳細（明細・税率ごとの合計・状態・消込・帳票と送付） */
export const getInvoice = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): InvoiceView | null {
    const invoice = ctx.stores.invoices.get(id);
    if (!invoice) return null;
    const cancellable = cancelInvoice(invoice.status, invoice.allocated);
    return {
      invoice,
      outstanding: invoiceOutstanding(invoice),
      overdue: isOverdue(invoice, ctx.clock.today()),
      kind: invoice.periodTo === null ? "per_shipment" : "closing",
      actions: { cancel: cancellable.ok, allocate: isOpenInvoice(invoice.status) },
      cancelBlocker:
        invoice.status === "cancelled" || cancellable.ok ? null : cancellable.error.message,
      document: invoice.document,
    };
  },
});

export interface UnbilledShipmentRow {
  readonly shipmentId: string;
  readonly shipmentVersion: number;
  readonly salesOrderId: string;
  readonly salesOrderNumber: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly shippedOn: string;
  readonly deliveryNoteNumber: string;
  /** 発送ごとの請求書にしたときの税込の合計（返品を含めない）。税率がなければ null */
  readonly total: number | null;
  /** 発送ごとに発行する（締め日なし）か、締め処理で発行する（締め日あり）か */
  readonly billing: "per_shipment" | "closing";
}

/** 未請求の発送（発送日の古い順）。締め日のない販売先の発送は、ここから請求書を発行する */
export const listUnbilled = defineQuery({
  permission: "view",
  input: pageInput.extend({
    customerId: z.string().max(64).optional(),
    billing: z.enum(["per_shipment", "closing"]).optional(),
  }),
  run(ctx, { customerId, billing, page, pageSize }): Page<UnbilledShipmentRow> {
    const all = ctx.stores.shipments.unbilled({ customerId: customerId || undefined }, 2000);
    const kinds = new Map<string, "per_shipment" | "closing">();
    const kindOf = (id: string) => {
      const known = kinds.get(id);
      if (known) return known;
      const p = ctx.stores.partners.get(id);
      const kind = p && termsOf(p) ? "closing" : "per_shipment";
      kinds.set(id, kind);
      return kind;
    };
    const rows = all
      .map((s): UnbilledShipmentRow => {
        const amounts = preview(ctx, [s], []);
        return {
          shipmentId: s.shipmentId,
          shipmentVersion: s.shipmentVersion,
          salesOrderId: s.salesOrderId,
          salesOrderNumber: s.salesOrderNumber,
          customerId: s.customerId,
          customerName: s.customerName,
          shippedOn: s.shippedOn,
          deliveryNoteNumber: s.deliveryNoteNumber,
          total: amounts.ok ? amounts.value.summary.total : null,
          billing: kindOf(s.customerId),
        };
      })
      .filter((r) => billing === undefined || r.billing === billing);
    const start = (page - 1) * pageSize;
    return { rows: rows.slice(start, start + pageSize), total: rows.length, page, pageSize };
  },
});

export interface InvoiceDraft {
  readonly shipment: UnbilledShipment;
  readonly customer: Pick<PartnerRecord, "id" | "name" | "honorific">;
  /** 締め日のある販売先なら、締め処理で発行する（ここでは発行できない） */
  readonly closing: boolean;
  /** 販売先の未請求の返品伝票（請求書に載せられるもの） */
  readonly returns: readonly SalesReturnRecord[];
  readonly selectedReturnIds: readonly string[];
  readonly preview: InvoicePreview | null;
  readonly previewError: string | null;
}

/**
 * 発送ごとの請求書の見積もり（発行の画面）。returnIds を指定しなければ、販売先の未請求の返品伝票をすべて載せる。
 * 発送が未請求でなければ null
 */
export const draftInvoice = defineQuery({
  permission: "view",
  input: z.object({
    shipmentId: idSchema,
    returnIds: z.array(idSchema).max(100).optional(),
  }),
  run(ctx, { shipmentId, returnIds }): InvoiceDraft | null {
    const shipment = ctx.stores.shipments.get(shipmentId);
    if (!shipment || shipment.cancelled || shipment.invoiceId !== null) return null;
    const order = ctx.stores.salesOrders.get(shipment.salesOrderId);
    const customer = order ? ctx.stores.partners.get(order.customerId) : undefined;
    if (!order || !customer) return null;
    const source = ctx.stores.shipments
      .unbilled(
        {
          customerId: order.customerId,
          shippedFrom: shipment.shippedOn,
          shippedTo: shipment.shippedOn,
        },
        2000,
      )
      .find((s) => s.shipmentId === shipmentId);
    if (!source) return null;
    const returns = ctx.stores.salesReturns.unbilled({ customerId: customer.id }, 100);
    const selected = returnIds ? new Set(returnIds) : new Set(returns.map((r) => r.id));
    const chosen = returns.filter((r) => selected.has(r.id));
    const plan = preview(ctx, [source], chosen);
    return {
      shipment: source,
      customer: { id: customer.id, name: customer.name, honorific: customer.honorific },
      closing: termsOf(customer) !== null,
      returns,
      selectedReturnIds: chosen.map((r) => r.id),
      preview: plan.ok ? plan.value : null,
      previewError: plan.ok ? null : plan.error.message,
    };
  },
});

export interface ClosingCandidate {
  readonly customerId: string;
  readonly customerName: string;
  readonly closingDay: number;
  readonly periodFrom: string;
  readonly periodTo: string;
  /** 締め日を迎えた（締め処理できる） */
  readonly ready: boolean;
  readonly dueOn: string;
  readonly shipments: readonly {
    readonly id: string;
    readonly version: number;
    readonly shippedOn: string;
    readonly deliveryNoteNumber: string;
    readonly salesOrderNumber: string;
  }[];
  readonly returns: readonly {
    readonly id: string;
    readonly version: number;
    readonly returnedOn: string;
    readonly number: string;
  }[];
  readonly summary: TaxSummary | null;
  /** 請求書にできない理由（合計がマイナス、税率の設定がないなど） */
  readonly error: string | null;
}

function closingCandidates(
  ctx: Pick<QueryContext, "stores" | "clock">,
  customerId: string | undefined,
): ClosingCandidate[] {
  const today = ctx.clock.today();
  const out: ClosingCandidate[] = [];
  for (const c of ctx.stores.invoices.closingCustomers(customerId)) {
    if (c.oldestUnbilledOn === null) continue;
    const target = closingTarget(c.oldestUnbilledOn, c.closingDay, today);
    const shipments = ctx.stores.shipments.unbilled(
      { customerId: c.id, shippedFrom: target.from, shippedTo: target.to },
      MAX_SOURCES,
    );
    const returns = ctx.stores.salesReturns.unbilled(
      { customerId: c.id, returnedTo: target.to },
      MAX_SOURCES,
    );
    const plan = preview(ctx, shipments, returns);
    out.push({
      customerId: c.id,
      customerName: c.name,
      closingDay: c.closingDay,
      periodFrom: target.from,
      periodTo: target.to,
      ready: target.ready,
      dueOn: closingDueDate(target.to, c),
      shipments: shipments.map((s) => ({
        id: s.shipmentId,
        version: s.shipmentVersion,
        shippedOn: s.shippedOn,
        deliveryNoteNumber: s.deliveryNoteNumber,
        salesOrderNumber: s.salesOrderNumber,
      })),
      returns: returns.map((r) => ({
        id: r.id,
        version: r.version,
        returnedOn: r.returnedOn,
        number: r.number,
      })),
      summary: plan.ok ? plan.value.summary : null,
      error: plan.ok ? null : plan.error.message,
    });
  }
  return out.toSorted((a, b) => a.periodTo.localeCompare(b.periodTo));
}

/**
 * 締め処理の対象：締め日のある販売先ごとに、最も古い未請求の発送が属する締め期間と、
 * その期間の未請求の発送・締め日までの未請求の返品伝票、請求書にしたときの金額。締め日の早い順
 */
export const listClosingCandidates = defineQuery({
  permission: "view",
  input: z.object({ customerId: z.string().max(64).optional() }),
  run(ctx, { customerId }): { today: string; candidates: ClosingCandidate[] } {
    return {
      today: ctx.clock.today(),
      candidates: closingCandidates(ctx, customerId || undefined),
    };
  },
});

export interface BillingDashboard {
  readonly today: string;
  /** 支払期限を過ぎた請求書（未入金・一部入金） */
  readonly overdueInvoices: number;
  /** 最新の送付に失敗した請求書（取り消していないもの） */
  readonly failedSends: number;
  /** 締め処理待ちの販売先（締め日を迎えた期間に未請求の発送がある） */
  readonly closingWaiting: number;
}

/** ダッシュボードの「請求・入金」の欄の件数（要件定義書 3.13 経理） */
export const billingDashboard = defineQuery({
  permission: "view",
  input: z.object({}),
  run(ctx): BillingDashboard {
    const today = ctx.clock.today();
    const closingWaiting = ctx.stores.invoices
      .closingCustomers()
      .filter(
        (c) =>
          c.oldestUnbilledOn !== null &&
          closingTarget(c.oldestUnbilledOn, c.closingDay, today).ready,
      ).length;
    return {
      today,
      overdueInvoices: ctx.stores.invoices.count({ overdueAsOf: today }),
      failedSends: ctx.stores.invoices.count({ sendStatus: "failed", excludeCancelled: true }),
      closingWaiting,
    };
  },
});
