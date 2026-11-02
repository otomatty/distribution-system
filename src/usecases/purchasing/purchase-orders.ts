/**
 * 発注（要件定義書 3.5、4章 発注の状態遷移）。
 * - 発注書は仕入先ごとに1枚で、商品はその仕入先の取扱商品に限る
 * - 作成中だけ明細を編集できる。確定（作成中 → 発注済み）と送付は1つのユースケース
 * - 取消は入荷前だけで、理由を記録する。メモは状態に関係なく編集できる
 */
import { z } from "zod";

import { isBusinessDate, paymentDueDate } from "../../domain/dates";
import { lineAmount, parseYenToCenti } from "../../domain/money";
import {
  cancelOrder,
  cancelReceipt,
  canEditOrder,
  confirmOrder,
  orderAmounts,
  orderLinePrice,
  remainingQuantity,
  returnableUnits,
  type PricedLine,
  type PurchaseOrderStatus,
} from "../../domain/purchasing";
import { err, ok, type FieldError, type Result } from "../../domain/result";
import { can } from "../../domain/roles";
import { lotWarnings } from "../../domain/sales";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE, type UsecaseContext } from "../core";
import { emailInput } from "../masters/contact";
import type { ItemRecord } from "../masters/items.port";
import type { DocumentSendRecord, DocumentSummary } from "../platform/documents.port";
import {
  businessDate,
  idSchema,
  optionalBusinessDate,
  optionalText,
  pageInput,
  requiredText,
  version,
  type Page,
} from "../schemas";
import { closingTermsOf, countBy, fieldError, taxRatesOn, writeMeta } from "./common";
import { checkSalesOrderLink } from "./maker-direct";
import type {
  PurchaseOrderDetail,
  PurchaseOrderFields,
  PurchaseOrderFilter,
  PurchaseOrderLineFields,
  PurchaseOrderLineRecord,
  PurchaseOrderSummary,
} from "./purchase-orders.port";
import type { PurchaseReturnRecord } from "./purchase-returns.port";
import type { ReceiptRecord } from "./receipts.port";
import type { PurchaseOrderSnapshot } from "./snapshots";

export const PURCHASE_ORDER_STATUSES = [
  "draft",
  "ordered",
  "received",
  "paid",
  "cancelled",
] as const satisfies readonly PurchaseOrderStatus[];

const optionalId = z
  .string()
  .max(64)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

const lineInput = z.object({
  itemId: idSchema,
  quantity: z
    .number({ error: "数量は数字で入力してください" })
    .int("数量は整数で入力してください")
    .min(1, "数量は1以上で入力してください")
    .max(9_999_999, "数量が大きすぎます"),
  /** 単価（centi-yen）。未入力は null（エラーになる） */
  unitPriceCenti: z
    .number({ error: "単価は小数第2位までの数字で入力してください（例：1234.56）" })
    .int("単価は小数第2位までで入力してください")
    .min(0, "単価は0以上で入力してください")
    .max(99_999_999_999, "単価が大きすぎます")
    .nullable(),
  memo: optionalText(200),
});

const fieldsInput = z.object({
  supplierId: idSchema,
  orderedOn: businessDate,
  supplierContactName: optionalText(100),
  destinationKind: z.enum(["location", "customer", "other"], { error: "納入先を選んでください" }),
  destinationLocationId: optionalId,
  destinationCustomerId: optionalId,
  destinationAddress: optionalText(300),
  employeeId: optionalId,
  deliveryRequestedOn: optionalBusinessDate,
  /** 取引条件のない仕入先のときだけ使う（ある仕入先は自動で計算する） */
  paymentDueOn: optionalBusinessDate,
  /** メーカー直の受注から作るとき、その受注（作るときだけ使い、編集では変わらない） */
  salesOrderId: optionalId,
  memo: optionalText(2000),
  lines: z.array(lineInput).max(200, "1つの発注に入れられる商品は200件までです").default([]),
});

type FieldsInput = z.output<typeof fieldsInput>;

interface PreparedOrder {
  readonly fields: PurchaseOrderFields;
  readonly lines: PurchaseOrderLineFields[];
}

function checkDestination(
  ctx: Pick<UsecaseContext, "stores">,
  input: FieldsInput,
  before: PurchaseOrderDetail | undefined,
): Result<
  Pick<
    PurchaseOrderFields,
    "destinationLocationId" | "destinationCustomerId" | "destinationAddress"
  >
> {
  switch (input.destinationKind) {
    case "location": {
      const id = input.destinationLocationId;
      const location = id ? ctx.stores.locations.get(id) : undefined;
      if (!id || !location) return fieldError("destinationLocationId", "保管場所を選んでください");
      if (location.archived && before?.destinationLocationId !== id)
        return fieldError("destinationLocationId", "取引終了の保管場所は選べません");
      return ok({
        destinationLocationId: id,
        destinationCustomerId: null,
        destinationAddress: null,
      });
    }
    case "customer": {
      const id = input.destinationCustomerId;
      const customer = id ? ctx.stores.partners.get(id) : undefined;
      if (!id || !customer || !customer.isCustomer)
        return fieldError("destinationCustomerId", "納入先の販売先を選んでください");
      if (customer.archived && before?.destinationCustomerId !== id)
        return fieldError("destinationCustomerId", "取引終了の販売先は選べません");
      return ok({
        destinationLocationId: null,
        destinationCustomerId: id,
        destinationAddress: null,
      });
    }
    case "other":
      if (!input.destinationAddress)
        return fieldError("destinationAddress", "届け先の名前と住所を入力してください");
      return ok({
        destinationLocationId: null,
        destinationCustomerId: null,
        destinationAddress: input.destinationAddress,
      });
  }
  return fieldError("destinationKind", "納入先を選んでください");
}

/**
 * 明細を確かめて、保存する明細を作る（仕入先の取扱商品か、取扱終了でないか、単価）。
 * 入数と税区分は商品マスタの値を写す。
 */
function prepareLines(
  input: FieldsInput,
  items: ReadonlyMap<string, ItemRecord>,
  before: PurchaseOrderDetail | undefined,
): Result<PurchaseOrderLineFields[]> {
  const errors: FieldError[] = [];
  const lines: PurchaseOrderLineFields[] = [];
  const seen = new Set<string>();
  const beforeItems = new Set(before?.lines.map((l) => l.itemId));
  input.lines.forEach((l, i) => {
    const item = items.get(l.itemId);
    const field = `lines.${i}.itemId`;
    if (!item) {
      errors.push({ field, message: "登録されていない商品です" });
      return;
    }
    if (seen.has(l.itemId)) errors.push({ field, message: "同じ商品が複数の行にあります" });
    seen.add(l.itemId);
    if (item.supplierId !== input.supplierId)
      errors.push({ field, message: "この仕入先の取扱商品ではありません" });
    if (item.discontinued && !beforeItems.has(l.itemId))
      errors.push({ field, message: "取扱終了の商品です" });
    const price = orderLinePrice(item.inputPriceOnOrder, l.unitPriceCenti);
    if (!price.ok) {
      errors.push({ field: `lines.${i}.unitPriceCenti`, message: price.error.message });
      return;
    }
    lines.push({
      itemId: l.itemId,
      quantity: l.quantity,
      unitPriceCenti: price.value,
      unitsPerPurchaseUnit: item.unitsPerPurchaseUnit,
      taxCategory: item.taxCategory,
      memo: l.memo,
    });
  });
  const [first] = errors;
  return first ? err("validation", first.message, { fields: errors }) : ok(lines);
}

/** 入力を検証して、保存する発注と明細を作る（合計と支払予定日は domain で計算する） */
function prepareOrder(
  ctx: UsecaseContext,
  input: FieldsInput,
  before: PurchaseOrderDetail | undefined,
): Result<PreparedOrder> {
  const supplier = ctx.stores.partners.get(input.supplierId);
  if (!supplier || !supplier.isSupplier) return fieldError("supplierId", "仕入先を選んでください");
  if (supplier.archived && before?.supplierId !== supplier.id)
    return fieldError("supplierId", "取引終了の仕入先は選べません");
  const destination = checkDestination(ctx, input, before);
  if (!destination.ok) return destination;
  const salesOrderId = before ? before.salesOrderId : input.salesOrderId;
  if (salesOrderId) {
    const link = checkSalesOrderLink(ctx, {
      salesOrderId,
      supplierId: supplier.id,
      destinationKind: input.destinationKind,
      destinationCustomerId: destination.value.destinationCustomerId,
      orderId: before?.id ?? null,
    });
    if (!link.ok) return link;
  }
  if (input.employeeId) {
    const employee = ctx.stores.employees.get(input.employeeId);
    if (!employee || (!employee.active && before?.employeeId !== input.employeeId))
      return fieldError("employeeId", "担当者を選んでください");
  }
  const items = new Map(
    ctx.stores.items.getMany(input.lines.map((l) => l.itemId)).map((i) => [i.id, i]),
  );
  const prepared = prepareLines(input, items, before);
  if (!prepared.ok) return prepared;
  const lines = prepared.value;
  const rates = taxRatesOn(ctx, input.orderedOn);
  if (!rates.ok) return rates;
  const { summary } = orderAmounts(
    lines,
    rates.value,
    ctx.stores.settings.getCompany().roundingMode,
  );
  const terms = closingTermsOf(supplier);
  const paymentDueOn = terms
    ? paymentDueDate(input.deliveryRequestedOn ?? input.orderedOn, terms)
    : input.paymentDueOn;
  return ok({
    fields: {
      supplierId: supplier.id,
      orderedOn: input.orderedOn,
      supplierContactName: input.supplierContactName,
      destinationKind: input.destinationKind,
      ...destination.value,
      employeeId: input.employeeId,
      deliveryRequestedOn: input.deliveryRequestedOn,
      paymentDueOn,
      sendMethod: before?.sendMethod ?? supplier.defaultSendMethod,
      salesOrderId,
      memo: input.memo,
      subtotal: summary.subtotal,
      tax: summary.tax,
      total: summary.total,
    },
    lines,
  });
}

function numbered(ctx: UsecaseContext, lines: readonly PurchaseOrderLineFields[]) {
  return lines.map((l, i) => ({ ...l, id: ctx.ids.next(), lineNo: i + 1 }));
}

export const createPurchaseOrder = defineCommand({
  permission: "purchaseOrders.manage",
  input: fieldsInput,
  run(ctx, input) {
    const prepared = prepareOrder(ctx, input, undefined);
    if (!prepared.ok) return prepared;
    const id = ctx.ids.next();
    const number = ctx.sequences.next("purchaseOrder", input.orderedOn);
    const lines = numbered(ctx, prepared.value.lines);
    ctx.stores.purchaseOrders.insert(id, number, prepared.value.fields, lines, writeMeta(ctx));
    ctx.audit.record({
      entityType: "purchase_order",
      entityId: id,
      action: "create",
      after: { number, status: "draft", ...prepared.value.fields, lines: prepared.value.lines },
    });
    return ok({ id, number });
  },
});

export const updatePurchaseOrder = defineCommand({
  permission: "purchaseOrders.manage",
  input: z.object({ id: idSchema, version, fields: fieldsInput }),
  run(ctx, { id, version: v, fields }) {
    const before = ctx.stores.purchaseOrders.get(id);
    if (!before) return err("not_found", "発注が見つかりません");
    if (!canEditOrder(before.status))
      return err(
        "invalid_state",
        "作成中の発注だけを編集できます（発注済み以降はメモだけ編集できます）",
      );
    const prepared = prepareOrder(ctx, fields, before);
    if (!prepared.ok) return prepared;
    if (!ctx.stores.purchaseOrders.update(id, v, prepared.value.fields, writeMeta(ctx)))
      return err("conflict", STALE_VERSION_MESSAGE);
    ctx.stores.purchaseOrders.replaceLines(id, numbered(ctx, prepared.value.lines));
    ctx.audit.record({
      entityType: "purchase_order",
      entityId: id,
      action: "update",
      before,
      after: { ...prepared.value.fields, lines: prepared.value.lines },
    });
    return ok({ id });
  },
});

/** 発注書の内容。金額は domain で計算した値を入れる（テンプレートは表示するだけ） */
function buildSnapshot(
  ctx: UsecaseContext,
  po: PurchaseOrderDetail,
): Result<{ snapshot: PurchaseOrderSnapshot; total: number }> {
  const rates = taxRatesOn(ctx, po.orderedOn);
  if (!rates.ok) return rates;
  const company = ctx.stores.settings.getCompany();
  const { lines, summary } = orderAmounts(po.lines, rates.value, company.roundingMode);
  const other = po.destinationKind === "other";
  // その他の届け先は、入力した名前と住所（destinationAddress）をそのまま載せる
  const destination: PurchaseOrderSnapshot["destination"] = {
    kind: po.destinationKind,
    name: other ? null : po.destinationName,
    postalCode: po.destination.postalCode,
    address: other ? po.destinationAddress : po.destination.address,
    phone: po.destination.phone,
  };
  return ok({
    total: summary.total,
    snapshot: {
      number: po.number,
      orderedOn: po.orderedOn,
      deliveryRequestedOn: po.deliveryRequestedOn,
      paymentDueOn: po.paymentDueOn,
      issuer: {
        name: company.name,
        registrationNumber: company.registrationNumber,
        postalCode: company.postalCode,
        address: company.address,
        phone: company.phone,
        fax: company.fax,
        email: company.email,
      },
      supplier: {
        name: po.supplierName,
        honorific: po.supplier.honorific,
        contactName: po.supplierContactName,
        postalCode: po.supplier.postalCode,
        address: po.supplier.address,
        phone: po.supplier.phone,
        fax: po.supplier.fax,
      },
      destination,
      employeeName: po.employeeName,
      lines: lines.map((l, i) => ({
        no: i + 1,
        itemCode: l.itemCode,
        itemName: l.itemName,
        jan: l.jan,
        quantity: l.quantity,
        purchaseUnitName: l.purchaseUnitName,
        unitsPerPurchaseUnit: l.unitsPerPurchaseUnit,
        salesUnitName: l.salesUnitName,
        unitPriceCenti: l.unitPriceCenti,
        amount: l.amount,
        taxCategory: l.taxCategory,
        memo: l.memo,
      })),
      taxGroups: [...summary.groups],
      subtotal: summary.subtotal,
      tax: summary.tax,
      total: summary.total,
      memo: po.memo,
    },
  });
}

/**
 * 確定と送付（作成中 → 発注済み）。発注書を発行し、送付方法がメールならメールで送る（送付は非同期）。
 * 「送付しない」（FAX・手渡しなど）は発行だけで、送ったことは帳票の画面で記録する。
 */
export const confirmPurchaseOrder = defineCommand({
  permission: "purchaseOrders.manage",
  input: z.object({
    id: idSchema,
    version,
    sendMethod: z.enum(["email", "none"], { error: "送付方法を選んでください" }),
    recipient: emailInput,
  }),
  run(ctx, { id, version: v, sendMethod, recipient }) {
    const po = ctx.stores.purchaseOrders.get(id);
    if (!po) return err("not_found", "発注が見つかりません");
    const next = confirmOrder(po.status, po.lines.length, sendMethod, recipient);
    if (!next.ok) return next;
    const built = buildSnapshot(ctx, po);
    if (!built.ok) return built;
    const confirmedAt = ctx.clock.now().toISOString();
    if (
      !ctx.stores.purchaseOrders.update(
        id,
        v,
        {
          status: next.value,
          confirmedAt,
          sendMethod,
          subtotal: built.value.snapshot.subtotal,
          tax: built.value.snapshot.tax,
          total: built.value.total,
        },
        writeMeta(ctx),
      )
    )
      return err("conflict", STALE_VERSION_MESSAGE);
    const documentId = ctx.documents.issue({
      documentType: "purchase_order",
      number: po.number,
      entityId: po.id,
      partnerId: po.supplierId,
      transactionDate: po.orderedOn,
      amount: built.value.total,
      snapshot: built.value.snapshot,
    });
    const sendId =
      sendMethod === "email" && recipient ? ctx.documents.sendEmail(documentId, recipient) : null;
    ctx.audit.record({
      entityType: "purchase_order",
      entityId: id,
      action: "confirm",
      before: { status: po.status },
      after: { status: next.value, sendMethod, recipient, documentId, sendId },
    });
    return ok({ id, documentId, sendId });
  },
});

/** 取消（入荷前だけ）。発行した発注書も取消済みにする（PDF と索引は残る） */
export const cancelPurchaseOrder = defineCommand({
  permission: "purchaseOrders.manage",
  input: z.object({ id: idSchema, version, reason: requiredText(500) }),
  run(ctx, { id, version: v, reason }) {
    const po = ctx.stores.purchaseOrders.get(id);
    if (!po) return err("not_found", "発注が見つかりません");
    const next = cancelOrder(po.status, ctx.stores.receipts.activeCount(id), reason);
    if (!next.ok) return next;
    if (
      !ctx.stores.purchaseOrders.update(
        id,
        v,
        { status: next.value, cancelReason: reason },
        writeMeta(ctx),
      )
    )
      return err("conflict", STALE_VERSION_MESSAGE);
    const documentIds = ctx.stores.documents.latestForEntities("purchase_order", [id]);
    for (const documentId of documentIds) ctx.documents.cancel(documentId);
    ctx.audit.record({
      entityType: "purchase_order",
      entityId: id,
      action: "cancel",
      before: { status: po.status },
      after: { status: next.value, reason, cancelledDocumentIds: documentIds },
    });
    return ok({ id });
  },
});

/** メモの編集（状態に関係なくできる） */
export const updatePurchaseOrderMemo = defineCommand({
  permission: "purchaseOrders.manage",
  input: z.object({ id: idSchema, version, memo: optionalText(2000) }),
  run(ctx, { id, version: v, memo }) {
    const po = ctx.stores.purchaseOrders.get(id);
    if (!po) return err("not_found", "発注が見つかりません");
    if (!ctx.stores.purchaseOrders.update(id, v, { memo }, writeMeta(ctx)))
      return err("conflict", STALE_VERSION_MESSAGE);
    ctx.audit.record({
      entityType: "purchase_order",
      entityId: id,
      action: "update_memo",
      before: { memo: po.memo },
      after: { memo },
    });
    return ok({ id, version: v + 1 });
  },
});

// ---- 照会 -----------------------------------------------------------------------

export const purchaseOrderFilterInput = {
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
  supplierId: z.string().max(64).optional(),
  from: optionalBusinessDate,
  to: optionalBusinessDate,
  hasMemo: z.boolean().default(false),
  q: z.string().trim().max(100).optional(),
  /** 納品希望日を過ぎた未入荷の発注だけ（発注済み） */
  overdue: z.boolean().default(false),
};

type FilterInput = z.output<z.ZodObject<typeof purchaseOrderFilterInput>>;

export function toPurchaseOrderFilter(
  ctx: Pick<UsecaseContext, "clock">,
  f: FilterInput,
): PurchaseOrderFilter {
  return {
    status: f.overdue ? "ordered" : f.status,
    supplierId: f.supplierId || undefined,
    from: f.from ?? undefined,
    to: f.to ?? undefined,
    hasMemo: f.hasMemo,
    q: f.q || undefined,
    deliveryBefore: f.overdue ? ctx.clock.today() : undefined,
  };
}

/** 発注一覧（状態・仕入先・期間・メモの有無・キーワードで絞り込む。CSV も同じ照会をページごとに呼ぶ） */
export const listPurchaseOrders = defineQuery({
  permission: "view",
  input: pageInput.extend(purchaseOrderFilterInput),
  run(ctx, { page, pageSize, ...filter }): Page<PurchaseOrderSummary> {
    return ctx.stores.purchaseOrders.list(toPurchaseOrderFilter(ctx, filter), page, pageSize);
  },
});

export interface PurchaseOrderLineView extends PurchaseOrderLineRecord {
  /** 金額（税抜・円） */
  readonly amount: number;
  /** 残りの数（仕入単位） */
  readonly remaining: number;
  /** 取り消していない入荷の受入数の合計（仕入単位） */
  readonly acceptedQuantity: number;
  /** 仕入返品の数の合計（販売単位） */
  readonly returnedUnits: number;
  /** これから仕入返品できる数（販売単位） */
  readonly returnableUnits: number;
}

export interface PurchaseOrderView {
  readonly order: PurchaseOrderDetail;
  readonly lines: readonly PurchaseOrderLineView[];
  readonly taxGroups: readonly {
    category: string;
    rateBps: number;
    subtotal: number;
    tax: number;
  }[];
  readonly receipts: readonly ReceiptRecord[];
  readonly returns: readonly PurchaseReturnRecord[];
  /** 発行した発注書（取消済みを含む、新しい順）と最新の発注書の送付履歴 */
  readonly documents: readonly DocumentSummary[];
  readonly sends: readonly DocumentSendRecord[];
  /** 入荷を含む仕入先請求書（取消を除く） */
  readonly invoices: readonly { id: string; invoiceNumber: string | null; status: string }[];
  /** 仕入先の既定の送付方法とメールアドレス（確定の画面の初期値） */
  readonly supplierEmail: string | null;
  readonly supplierSendMethod: "email" | "none";
  /** 操作者が今できる操作（状態と権限から決める。画面はボタンの出し分けだけに使う） */
  readonly actions: {
    readonly edit: boolean;
    readonly confirm: boolean;
    readonly cancel: boolean;
    readonly memo: boolean;
    readonly receive: boolean;
    readonly returnGoods: boolean;
    readonly invoice: boolean;
  };
  /** 取り消せる入荷の ID */
  readonly cancellableReceiptIds: readonly string[];
}

/** 発注詳細（明細ごとの残り・受入・返品、入荷の履歴、仕入返品、発注書と送付履歴、仕入先請求書） */
export const getPurchaseOrder = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): PurchaseOrderView | null {
    const order = ctx.stores.purchaseOrders.get(id);
    if (!order) return null;
    const mode = ctx.stores.settings.getCompany().roundingMode;
    const accepted = countBy(ctx.stores.receipts.acceptedByLine(id), (a) => a.accepted);
    const returned = countBy(ctx.stores.purchaseReturns.returnedByLine(id), (r) => r.units);
    const lines = order.lines.map((l): PurchaseOrderLineView => {
      const acceptedQuantity = accepted(l.id);
      const returnedUnits = returned(l.id);
      return {
        ...l,
        amount: lineAmount(l.unitPriceCenti, l.quantity, mode),
        remaining: remainingQuantity(l),
        acceptedQuantity,
        returnedUnits,
        returnableUnits: returnableUnits({ ...l, acceptedQuantity, returnedUnits }),
      };
    });
    const rates = taxRatesOn(ctx, order.orderedOn);
    const taxGroups = rates.ok ? orderAmounts(order.lines, rates.value, mode).summary.groups : [];
    const documents = ctx.stores.documents
      .search({ documentType: "purchase_order", number: order.number }, 1, 20)
      .rows.filter((d) => d.entityId === id);
    const latest = documents[0];
    const supplier = ctx.stores.partners.get(order.supplierId);
    const receipts = ctx.stores.receipts.listByOrder(id);
    const active = receipts.filter((r) => !r.cancelled);
    const roles = ctx.actor.roles;
    const manage = can(roles, "purchaseOrders.manage");
    const editable = canEditOrder(order.status);
    return {
      order,
      lines,
      taxGroups,
      receipts,
      actions: {
        edit: manage && editable,
        confirm: manage && editable,
        cancel: manage && cancelOrder(order.status, active.length, "取消").ok,
        memo: manage,
        receive: can(roles, "receipts.manage") && order.status === "ordered",
        returnGoods:
          can(roles, "purchaseReturns.manage") &&
          order.destinationKind === "location" &&
          lines.some((l) => l.returnableUnits > 0),
        invoice:
          can(roles, "supplierInvoices.manage") && active.some((r) => r.supplierInvoiceId === null),
      },
      cancellableReceiptIds: can(roles, "receipts.manage")
        ? active
            .filter((r) => cancelReceipt(order.status, r.supplierInvoiceStatus === "paid").ok)
            .map((r) => r.id)
        : [],
      returns: ctx.stores.purchaseReturns.listByOrder(id),
      documents,
      sends: latest ? ctx.stores.documents.sends(latest.id) : [],
      invoices: ctx.stores.supplierInvoices.invoicesForOrder(id),
      supplierEmail: supplier?.email ?? null,
      supplierSendMethod: supplier?.defaultSendMethod ?? "none",
    };
  },
});

export interface OrderPreviewLine {
  readonly itemId: string;
  /** 金額（税抜・円）。単価が未入力なら null */
  readonly amount: number | null;
  readonly error: string | null;
  /** 最低ロット未満などの警告（保存はできる） */
  readonly warnings: readonly string[];
}

/** 画面の「12」形式の数量。不正なら null */
function parseQuantity(text: string): number | null {
  const t = text.replaceAll(",", "").trim();
  return /^\d{1,7}$/.test(t) && Number(t) >= 1 ? Number(t) : null;
}

/**
 * 発注の作成・編集の画面で、明細の金額と合計をその場で計算する（変わった行と合計欄だけを差し替える）。
 * 保存はしない。数量・単価は画面に入力された文字のまま受け取り、不正な行は合計に含めない。
 */
export const previewPurchaseOrder = defineQuery({
  permission: "view",
  input: z.object({
    orderedOn: z.string().max(10),
    lines: z
      .array(
        z.object({ itemId: idSchema, quantity: z.string().max(20), price: z.string().max(20) }),
      )
      .max(200),
  }),
  run(ctx, input) {
    const items = new Map(
      ctx.stores.items.getMany(input.lines.map((l) => l.itemId)).map((i) => [i.id, i]),
    );
    const mode = ctx.stores.settings.getCompany().roundingMode;
    const rates = taxRatesOn(
      ctx,
      isBusinessDate(input.orderedOn) ? input.orderedOn : ctx.clock.today(),
    );
    const priced: PricedLine[] = [];
    const lines = input.lines.map((l): OrderPreviewLine => {
      const item = items.get(l.itemId);
      if (!item)
        return { itemId: l.itemId, amount: null, error: "登録されていない商品です", warnings: [] };
      const quantity = parseQuantity(l.quantity);
      const priceText = l.price.trim();
      const price = priceText === "" ? null : (parseYenToCenti(priceText) ?? Number.NaN);
      if (price !== null && Number.isNaN(price))
        return {
          itemId: l.itemId,
          amount: null,
          error: "単価は小数第2位までの数字で入力してください（例：1234.56）",
          warnings: [],
        };
      const checked = orderLinePrice(item.inputPriceOnOrder, price);
      if (quantity === null)
        return {
          itemId: l.itemId,
          amount: null,
          error: "数量は1以上の整数で入力してください",
          warnings: [],
        };
      if (!checked.ok)
        return { itemId: l.itemId, amount: null, error: checked.error.message, warnings: [] };
      priced.push({ quantity, unitPriceCenti: checked.value, taxCategory: item.taxCategory });
      return {
        itemId: l.itemId,
        amount: lineAmount(checked.value, quantity, mode),
        error: null,
        warnings: lotWarnings(quantity, item.purchaseMinLot),
      };
    });
    const summary = rates.ok ? orderAmounts(priced, rates.value, mode).summary : null;
    return { lines, summary, error: rates.ok ? null : rates.error.message };
  },
});
