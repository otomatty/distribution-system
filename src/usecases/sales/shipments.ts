/**
 * 発送（要件定義書 3.9、4章 受注の状態遷移）。発送で引当を外して在庫を減らし、納品書を発行する。
 * 発送の取消は請求書に載る前だけ（shipments.invoice_id が null）で、在庫を打ち消しで戻し、引当も戻す。
 * メーカー直の受注は引き当てていないので、在庫を動かさずに発送済みにする（納品書は発行する）。
 * メーカー直の受注は保管場所を持たない（orders.ts の見出しの検証で決まる）ので、在庫を動かすかは保管場所の有無で決める。
 */
import { z } from "zod";

import { err, ok, type Result } from "../../domain/result";
import {
  cancelShipment,
  planBulkShipment,
  shippingMatrix,
  shipSalesOrder,
  type ShippingMatrix,
} from "../../domain/sales";
import {
  defineCommand,
  defineQuery,
  STALE_VERSION_MESSAGE,
  type QueryContext,
  type UsecaseContext,
} from "../core";
import { BULK_DOCUMENTS_MAX, type BulkDocumentsPayload } from "../platform/job-payloads";
import { businessDate, idSchema, optionalBusinessDate, requiredText, version } from "../schemas";
import { changeAllocation, postStock, reverseStock, stockLevels } from "../stock/ledger";
import type { SalesOrderDetail, SalesOrderLineDetail } from "./orders.port";
import type { UnbilledShipment } from "./shipments.port";
import { buildDeliveryNoteSnapshot } from "./snapshots";

function meta(ctx: UsecaseContext) {
  return { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId };
}

function notFuture(ctx: UsecaseContext, date: string): Result<never> | undefined {
  if (date <= ctx.clock.today()) return undefined;
  const message = "今日より後の日付では発送できません";
  return err("validation", message, { fields: [{ field: "shippedOn", message }] });
}

export interface ShipResult {
  readonly salesOrderId: string;
  readonly salesOrderNumber: string;
  readonly shipmentId: string;
  readonly deliveryNoteNumber: string;
  readonly documentId: string;
}

/**
 * 受注を1件発送する（個別の発送と一括発送で共通）。
 * 引当を外し、在庫を減らし（足りなければ insufficient_stock）、納品書を採番して発行する。
 */
function shipOrder(
  ctx: UsecaseContext,
  order: SalesOrderDetail,
  expectedVersion: number,
  shippedOn: string,
): Result<ShipResult> {
  const next = shipSalesOrder(order.status);
  if (!next.ok) return err(next.error.code, `${order.number}：${next.error.message}`);
  if (!ctx.stores.salesOrders.update(order.id, expectedVersion, { status: next.value }, meta(ctx)))
    return err("conflict", `${order.number}：${STALE_VERSION_MESSAGE}`);
  const snapshot = buildDeliveryNoteSnapshot({
    number: ctx.sequences.next("deliveryNote", shippedOn),
    shippedOn,
    order,
    company: ctx.stores.settings.getCompany(),
    taxRates: ctx.stores.settings.listTaxRates(),
  });
  if (!snapshot.ok) return snapshot;
  const number = snapshot.value.number;
  const shipmentId = ctx.ids.next();
  const locationId = order.locationId;
  if (locationId !== null) {
    const released = changeAllocation(
      ctx,
      order.lines.map((l) => ({ itemId: l.itemId, locationId, quantity: -l.quantity })),
    );
    if (!released.ok) return released;
    const posted = postStock(
      ctx,
      { sourceType: "shipment", sourceId: shipmentId, businessDate: shippedOn, memo: order.number },
      order.lines.map((l) => ({
        itemId: l.itemId,
        locationId,
        quantity: -l.quantity,
        reason: "shipment",
      })),
    );
    if (!posted.ok) return posted;
  }
  ctx.stores.shipments.insert(
    {
      id: shipmentId,
      salesOrderId: order.id,
      deliveryNoteNumber: number,
      shippedOn,
      invoiceId: null,
      cancelled: false,
      cancelReason: null,
    },
    meta(ctx),
  );
  const documentId = ctx.documents.issue({
    documentType: "delivery_note",
    number,
    entityId: shipmentId,
    partnerId: order.customerId,
    transactionDate: shippedOn,
    amount: snapshot.value.total,
    snapshot: snapshot.value,
  });
  ctx.audit.record({
    entityType: "sales_order",
    entityId: order.id,
    action: "ship",
    before: { status: order.status },
    after: { status: next.value, shipmentId, deliveryNoteNumber: number, shippedOn },
  });
  return ok({
    salesOrderId: order.id,
    salesOrderNumber: order.number,
    shipmentId,
    deliveryNoteNumber: number,
    documentId,
  });
}

/** 受注詳細からの個別の発送 */
export const shipSalesOrderCommand = defineCommand({
  permission: "shipments.manage",
  input: z.object({ id: idSchema, version, shippedOn: businessDate }),
  run(ctx, { id, version: v, shippedOn }) {
    const future = notFuture(ctx, shippedOn);
    if (future) return future;
    const order = ctx.stores.salesOrders.get(id);
    if (!order) return err("not_found", "受注が見つかりません");
    return shipOrder(ctx, order, v, shippedOn);
  },
});

/** 発送の取消（請求書に載る前だけ）。在庫を打ち消しの行で戻し、引当も戻し、納品書を取消済みにする */
export const cancelShipmentCommand = defineCommand({
  permission: "shipments.manage",
  input: z.object({ shipmentId: idSchema, version, reason: requiredText(500) }),
  run(ctx, { shipmentId, version: v, reason }) {
    const shipment = ctx.stores.shipments.get(shipmentId);
    if (!shipment) return err("not_found", "発送が見つかりません");
    if (shipment.cancelled) return err("invalid_state", "この発送はすでに取り消されています");
    const order = ctx.stores.salesOrders.get(shipment.salesOrderId);
    if (!order) return err("not_found", "受注が見つかりません");
    const next = cancelShipment(order.status, shipment.invoiceId !== null);
    if (!next.ok) return next;
    if (!ctx.stores.shipments.cancel(shipmentId, v, reason, meta(ctx)))
      return err("conflict", STALE_VERSION_MESSAGE);
    // 発送で減らした在庫を打ち消しの行で戻す（増やすだけなのでマイナスにはならない）
    const back = reverseStock(ctx, {
      sourceType: "shipment",
      sourceId: shipmentId,
      businessDate: ctx.clock.today(),
      memo: `発送の取消（${order.number}）：${reason}`,
    });
    if (!back.ok) return back;
    const locationId = order.locationId;
    if (locationId !== null) {
      const restored = changeAllocation(
        ctx,
        order.lines.map((l) => ({ itemId: l.itemId, locationId, quantity: l.quantity })),
      );
      if (!restored.ok) return restored;
    }
    // 同じトランザクションで読んだ版番号なので、ここで競合することはない
    ctx.stores.salesOrders.update(order.id, order.version, { status: next.value }, meta(ctx));
    for (const documentId of ctx.stores.documents.latestForEntities("delivery_note", [shipmentId]))
      ctx.documents.cancel(documentId);
    ctx.audit.record({
      entityType: "shipment",
      entityId: shipmentId,
      action: "cancel",
      before: { cancelled: false },
      after: { cancelled: true, reason },
    });
    ctx.audit.record({
      entityType: "sales_order",
      entityId: order.id,
      action: "cancel_shipment",
      before: { status: order.status },
      after: { status: next.value, shipmentId },
    });
    return ok({ salesOrderId: order.id });
  },
});

// ---- 一括発送 -------------------------------------------------------------------

export interface BulkCheckOrder {
  readonly id: string;
  readonly number: string;
  readonly version: number;
  readonly customerName: string;
  readonly locationId: string;
  readonly lineCount: number;
}

export interface BulkCheckShortage {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly salesUnitName: string;
  readonly shortBy: number;
}

export interface BulkCheck {
  /** 発送できる受注（受注番号の順） */
  readonly shippable: readonly BulkCheckOrder[];
  /** 在庫が足りない受注と、足りない商品と数 */
  readonly short: readonly (BulkCheckOrder & {
    readonly shortages: readonly BulkCheckShortage[];
  })[];
  /** 対象外（発送済み・取消・メーカー直・見つからないなど）の受注の ID */
  readonly ineligibleIds: readonly string[];
}

interface Planned {
  readonly order: SalesOrderDetail & { readonly locationId: string };
  /** 発送するときに確かめる版番号（確認の画面で見た版番号。照会では今の版番号） */
  readonly expectedVersion: number;
}

interface BulkPlan {
  readonly shippable: readonly Planned[];
  readonly short: readonly (Planned & {
    readonly shortages: readonly {
      readonly line: SalesOrderLineDetail;
      readonly shortBy: number;
    }[];
  })[];
  readonly ineligibleIds: readonly string[];
}

function hasLocation(
  order: SalesOrderDetail,
): order is SalesOrderDetail & { readonly locationId: string } {
  return order.locationId !== null;
}

/**
 * 一括発送の計画。受注番号の順に保管場所の現在庫から引いていき、足りない受注を見つける。
 * 照会（確認の画面）と一括発送のコマンドで同じ計画を使う。
 */
function planBulk(
  ctx: Pick<QueryContext, "stores">,
  requests: readonly { readonly id: string; readonly version: number | null }[],
): BulkPlan {
  const eligible: Planned[] = [];
  const ineligibleIds: string[] = [];
  for (const r of requests) {
    const order = ctx.stores.salesOrders.get(r.id);
    if (order && order.status === "received" && hasLocation(order))
      eligible.push({ order, expectedVersion: r.version ?? order.version });
    else ineligibleIds.push(r.id);
  }
  eligible.sort((a, b) => a.order.number.localeCompare(b.order.number));
  const byLocation = new Map<string, Planned[]>();
  for (const p of eligible) {
    const list = byLocation.get(p.order.locationId);
    if (list) list.push(p);
    else byLocation.set(p.order.locationId, [p]);
  }
  const shippable = new Set<Planned>();
  const short = new Map<Planned, BulkPlan["short"][number]>();
  for (const [locationId, list] of byLocation) {
    const itemIds = [...new Set(list.flatMap((p) => p.order.lines.map((l) => l.itemId)))];
    const onHand = new Map(
      [...stockLevels(ctx, itemIds, locationId)].map(([itemId, level]) => [itemId, level.onHand]),
    );
    const plan = planBulkShipment(
      list.map((p) => ({ planned: p, lines: p.order.lines })),
      onHand,
    );
    for (const o of plan.shippable) shippable.add(o.planned);
    for (const s of plan.short)
      short.set(s.order.planned, { ...s.order.planned, shortages: s.shortages });
  }
  return {
    shippable: eligible.filter((p) => shippable.has(p)),
    short: eligible.flatMap((p) => {
      const s = short.get(p);
      return s ? [s] : [];
    }),
    ineligibleIds,
  };
}

function checkOrderView(p: Planned): BulkCheckOrder {
  return {
    id: p.order.id,
    number: p.order.number,
    version: p.order.version,
    customerName: p.order.customerName,
    locationId: p.order.locationId,
    lineCount: p.order.lines.length,
  };
}

function checkView(plan: BulkPlan): BulkCheck {
  return {
    shippable: plan.shippable.map(checkOrderView),
    short: plan.short.map((s) => ({
      ...checkOrderView(s),
      shortages: s.shortages.map((x) => ({
        itemId: x.line.itemId,
        itemCode: x.line.itemCode,
        itemName: x.line.itemName,
        salesUnitName: x.line.salesUnitName,
        shortBy: x.shortBy,
      })),
    })),
    ineligibleIds: plan.ineligibleIds,
  };
}

const orderIdsInput = z.array(idSchema).max(200, "一度に発送できるのは200件までです");

/** 一括発送の確認：選んだ受注のうち、在庫が足りずに発送できないもの */
export const checkBulkShipment = defineQuery({
  permission: "view",
  input: z.object({ orderIds: orderIdsInput }),
  run(ctx, { orderIds }): BulkCheck {
    return checkView(
      planBulk(
        ctx,
        [...new Set(orderIds)].map((id) => ({ id, version: null })),
      ),
    );
  },
});

/**
 * 一括発送。選んだ受注（exclude で外したものを除く）を1つのトランザクションで発送する。
 * 在庫が足りない受注が1件でもあれば何も発送せずに insufficient_stock を返す（画面で「外して続ける」か「中止」を選ぶ）。
 * 受注の版番号が確認の画面を開いた後に変わっていれば conflict。
 */
export const bulkShip = defineCommand({
  permission: "shipments.manage",
  input: z.object({
    orders: z
      .array(z.object({ id: idSchema, version }))
      .min(1, "発送する受注を選んでください")
      .max(200, "一度に発送できるのは200件までです"),
    exclude: z.array(idSchema).max(200).default([]),
    shippedOn: businessDate,
  }),
  run(ctx, { orders, exclude, shippedOn }) {
    const future = notFuture(ctx, shippedOn);
    if (future) return future;
    const excluded = new Set(exclude);
    const targets = orders.filter((o) => !excluded.has(o.id));
    if (targets.length === 0) return err("validation", "発送する受注を選んでください");
    const plan = planBulk(ctx, targets);
    if (plan.ineligibleIds.length > 0) {
      return err(
        "invalid_state",
        "発送できない状態の受注が含まれています。画面を開き直してください",
        { details: plan.ineligibleIds },
      );
    }
    if (plan.short.length > 0) {
      return err("insufficient_stock", "在庫が足りない受注があります", {
        details: plan.short.flatMap((s) =>
          s.shortages.map((x) => `${x.line.itemId}\u0000${s.order.locationId}\u0000${x.shortBy}`),
        ),
      });
    }
    const shipped: ShipResult[] = [];
    for (const p of plan.shippable) {
      const r = shipOrder(ctx, p.order, p.expectedVersion, shippedOn);
      if (!r.ok) return r;
      shipped.push(r.value);
    }
    return ok({ shipped, excluded: [...excluded] });
  },
});

/** 発送の納品書をまとめて1つの PDF にする（非同期。処理状況の画面で進み具合とダウンロード） */
export const bulkDeliveryNotes = defineCommand({
  permission: "view",
  input: z.object({
    shipmentIds: z.array(idSchema).min(1).max(BULK_DOCUMENTS_MAX),
    name: z.string().trim().max(100).optional(),
  }),
  run(ctx, { shipmentIds, name }) {
    const documentIds = ctx.stores.shipments.deliveryNoteIds([...new Set(shipmentIds)]);
    if (documentIds.length === 0) return err("validation", "PDF にする納品書がありません");
    const payload: BulkDocumentsPayload = {
      documentIds,
      name: name || `納品書_${ctx.clock.today()}`,
    };
    const jobId = ctx.jobs.enqueue("bulk_documents", payload, documentIds.length);
    ctx.audit.record({
      entityType: "job",
      entityId: jobId,
      action: "enqueue_bulk_delivery_notes",
      after: { count: documentIds.length, name: payload.name },
    });
    return ok({ jobId, count: documentIds.length });
  },
});

// ---- 発送リスト -------------------------------------------------------------------

export interface ShippingListItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly salesUnitName: string;
  /** 保管場所の現在庫 */
  readonly onHand: number;
}

export interface ShippingListCustomer {
  readonly id: string;
  readonly name: string;
  readonly honorific: "御中" | "様";
  readonly orders: readonly {
    readonly id: string;
    readonly number: string;
    readonly memo: string | null;
  }[];
}

export interface ShippingList {
  readonly date: string;
  readonly locationId: string;
  readonly locationName: string;
  /** 行（商品コードの順） */
  readonly items: readonly ShippingListItem[];
  /** 列（その日に受注がある販売先だけ。読み仮名の順、列は販売先の ID で管理する） */
  readonly customers: readonly ShippingListCustomer[];
  readonly matrix: ShippingMatrix;
  /** 発送する受注（受注番号の順） */
  readonly orders: readonly BulkCheckOrder[];
  /** 今の在庫では発送できない受注の ID（受注番号の順に在庫を引いた場合） */
  readonly shortOrderIds: readonly string[];
  /** 同じ出荷予定日 × 保管場所で、すでに発送した受注の発送 ID */
  readonly shippedShipmentIds: readonly string[];
}

/** 発送リスト：出荷予定日 × 保管場所の、行が商品・列が販売先・右端が合計の表（受注済みの受注） */
export const shippingList = defineQuery({
  permission: "view",
  input: z.object({ date: businessDate, locationId: idSchema }),
  run(ctx, { date, locationId }): ShippingList | null {
    const location = ctx.stores.locations.get(locationId);
    if (!location) return null;
    const orders = ctx.stores.salesOrders.forShipping(date, locationId);
    const items = new Map<string, ShippingListItem>();
    const customers = new Map<string, { customer: ShippingListCustomer; kana: string }>();
    for (const o of orders) {
      for (const l of o.lines) {
        items.set(l.itemId, {
          id: l.itemId,
          code: l.itemCode,
          name: l.itemName,
          salesUnitName: l.salesUnitName,
          onHand: l.onHand,
        });
      }
      const c = customers.get(o.customerId);
      customers.set(o.customerId, {
        kana: o.customerKana,
        customer: {
          id: o.customerId,
          name: o.customerName,
          honorific: o.customerHonorific,
          orders: [...(c?.customer.orders ?? []), { id: o.id, number: o.number, memo: o.memo }],
        },
      });
    }
    const rows = [...items.values()].toSorted((a, b) => a.code.localeCompare(b.code));
    // 読み仮名の順（同じ読み仮名なら受注番号の順のまま）
    const columns = [...customers.values()]
      .toSorted((a, b) => a.kana.localeCompare(b.kana, "ja"))
      .map((c) => c.customer);
    const check = checkView(
      planBulk(
        ctx,
        orders.map((o) => ({ id: o.id, version: null })),
      ),
    );
    const shipped = ctx.stores.shipments.activeForOrders(
      ctx.stores.salesOrders.shippedIds(date, locationId),
    );
    return {
      date,
      locationId,
      locationName: location.name,
      items: rows,
      customers: columns,
      matrix: shippingMatrix(
        orders,
        rows.map((i) => i.id),
        columns.map((c) => c.id),
      ),
      orders: [...check.shippable, ...check.short].toSorted((a, b) =>
        a.number.localeCompare(b.number),
      ),
      shortOrderIds: check.short.map((s) => s.id),
      shippedShipmentIds: shipped.map((s) => s.id),
    };
  },
});

/**
 * 未請求の発送（請求書が未発行で、取り消していないもの）と、請求書の明細にする受注明細・送料。
 * 請求の区分（請求書の発行・締め処理）が使う。
 */
export const listUnbilledShipments = defineQuery({
  permission: "view",
  input: z.object({
    customerId: z.string().max(64).optional(),
    shippedFrom: optionalBusinessDate,
    shippedTo: optionalBusinessDate,
    limit: z.number().int().min(1).max(2000).default(500),
  }),
  run(ctx, { customerId, shippedFrom, shippedTo, limit }): UnbilledShipment[] {
    return ctx.stores.shipments.unbilled(
      { customerId, shippedFrom: shippedFrom ?? undefined, shippedTo: shippedTo ?? undefined },
      limit,
    );
  },
});
