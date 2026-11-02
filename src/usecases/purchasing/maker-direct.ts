/**
 * メーカー直の受注からの発注（要件定義書 3.8 Should、6章 sales_orders ↔ purchase_orders）。
 * - 受注の明細を商品の仕入先ごとにまとめ、仕入先ごとに1枚の発注を作る（発注書は仕入先ごとに1枚）
 * - 納入先は受注の販売先。数量は販売単位から仕入単位に換算する（端数は切り上げ）
 * - 発注は受注を覚えておき（purchase_orders.sales_order_id）、受注と発注の両方の詳細に相手を表示する
 * - 同じ受注・同じ仕入先の発注は、取り消していないものが1枚だけ（二重に発注しない）
 *
 * 発注の作成そのものは purchaseOrders.create（salesOrderId つき）で行い、ここでは画面の初期値と検証を受け持つ。
 */
import { z } from "zod";

import {
  canOrderFromSalesOrder,
  checkMakerDirectDestination,
  checkMakerDirectLink,
  groupBySupplier,
  isActiveLinkedOrder,
  purchaseQuantityFor,
} from "../../domain/maker-direct";
import { stockQuantity, type DestinationKind } from "../../domain/purchasing";
import { err, type Result } from "../../domain/result";
import { can } from "../../domain/roles";
import { defineQuery, type QueryContext } from "../core";
import type { ItemRecord } from "../masters/items.port";
import type { SalesOrderDetail, SalesOrderLineDetail } from "../sales/orders.port";
import { idSchema } from "../schemas";
import type { PurchaseOrderSummary } from "./purchase-orders.port";

type Ctx = Pick<QueryContext, "stores">;

interface SupplierLine {
  readonly line: SalesOrderLineDetail;
  readonly item: ItemRecord;
  readonly supplierId: string;
}

/** 受注の明細と、その商品（仕入先・入数・仕入価格）。商品が見つからない明細は除く */
function linesWithItems(ctx: Ctx, order: SalesOrderDetail): SupplierLine[] {
  const items = new Map(
    ctx.stores.items.getMany(order.lines.map((l) => l.itemId)).map((i) => [i.id, i]),
  );
  return order.lines.flatMap((line) => {
    const item = items.get(line.itemId);
    return item ? [{ line, item, supplierId: item.supplierId }] : [];
  });
}

/** 受注から作った発注（取消を含む、新しい順） */
function linkedOrders(ctx: Ctx, salesOrderId: string): readonly PurchaseOrderSummary[] {
  return ctx.stores.purchaseOrders.list({ salesOrderId }, 1, 100).rows;
}

function otherActiveOrders(
  orders: readonly PurchaseOrderSummary[],
  supplierId: string,
  exceptId: string | null,
): string[] {
  return orders
    .filter(
      (o) => o.supplierId === supplierId && o.id !== exceptId && isActiveLinkedOrder(o.status),
    )
    .map((o) => o.number);
}

/**
 * 発注の作成・編集で、結びつける受注を確かめる（purchaseOrders.create / update から呼ぶ）。
 * 作るときはメーカー直の受注の状態・仕入先・納入先・二重の発注を、作成中の発注の編集では納入先だけを確かめる。
 */
export function checkSalesOrderLink(
  ctx: Ctx,
  link: {
    readonly salesOrderId: string;
    readonly supplierId: string;
    readonly destinationKind: DestinationKind;
    readonly destinationCustomerId: string | null;
    /** 編集する発注（作るときは null） */
    readonly orderId: string | null;
  },
): Result<true> {
  const order = ctx.stores.salesOrders.get(link.salesOrderId);
  if (!order) return err("not_found", "結びつける受注が見つかりません");
  if (link.orderId !== null)
    return checkMakerDirectDestination(
      link.destinationKind,
      link.destinationCustomerId,
      order.customerId,
    );
  return checkMakerDirectLink({
    salesOrder: order,
    supplierId: link.supplierId,
    lineSupplierIds: linesWithItems(ctx, order).map((l) => l.supplierId),
    destinationKind: link.destinationKind,
    destinationCustomerId: link.destinationCustomerId,
    otherActiveOrders: otherActiveOrders(linkedOrders(ctx, order.id), link.supplierId, null),
  });
}

export interface MakerDirectSupplier {
  readonly supplierId: string;
  readonly supplierName: string;
  /** この仕入先の商品の明細の数 */
  readonly lineCount: number;
  /** 取り消していない発注（あれば2枚目は作れない） */
  readonly activeOrder: { readonly id: string; readonly number: string } | null;
}

export interface MakerDirectPlan {
  readonly salesOrderId: string;
  /** 受注から作った発注（取消を含む、新しい順） */
  readonly orders: readonly PurchaseOrderSummary[];
  /** 受注の明細の商品の仕入先（明細に出てきた順） */
  readonly suppliers: readonly MakerDirectSupplier[];
  /** 操作者が発注を作れるか（権限と受注の状態。仕入先ごとには activeOrder で決まる） */
  readonly canCreate: boolean;
  /** 受注の状態のために作れない理由（取り消した受注など） */
  readonly blockedReason: string | null;
}

/** 受注詳細の「メーカー直の発注」の欄：受注から作った発注と、仕入先ごとに発注を作れるか */
export const makerDirectPlan = defineQuery({
  permission: "view",
  input: z.object({ salesOrderId: idSchema }),
  run(ctx, { salesOrderId }): MakerDirectPlan | null {
    const order = ctx.stores.salesOrders.get(salesOrderId);
    if (!order) return null;
    const orders = linkedOrders(ctx, order.id);
    const suppliers = groupBySupplier(linesWithItems(ctx, order)).map((g): MakerDirectSupplier => {
      const active = orders.find(
        (o) => o.supplierId === g.supplierId && isActiveLinkedOrder(o.status),
      );
      return {
        supplierId: g.supplierId,
        supplierName: g.lines[0]?.item.supplierName ?? "",
        lineCount: g.lines.length,
        activeOrder: active ? { id: active.id, number: active.number } : null,
      };
    });
    const state = canOrderFromSalesOrder(order);
    return {
      salesOrderId: order.id,
      orders,
      suppliers,
      canCreate: can(ctx.actor.roles, "purchaseOrders.manage") && state.ok,
      blockedReason: state.ok ? null : state.error.message,
    };
  },
});

export interface MakerDirectDraftLine {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  /** 受注の数量（販売単位） */
  readonly salesQuantity: number;
  readonly salesUnitName: string;
  /** 発注の数量（仕入単位、端数は切り上げ） */
  readonly quantity: number;
  readonly purchaseUnitName: string;
  readonly unitsPerPurchaseUnit: number;
  /** 発注の数量を販売単位にした数（発注の数量 × 入数） */
  readonly orderedUnits: number;
  /** 切り上げで受注より多くなる数（販売単位） */
  readonly surplusUnits: number;
  /** 単価の初期値（仕入価格）。「発注時に仕入価格を入力する」商品は null */
  readonly unitPriceCenti: number | null;
}

export interface MakerDirectDraft {
  readonly salesOrderId: string;
  readonly salesOrderNumber: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly deliveryRequestedOn: string | null;
  readonly lines: readonly MakerDirectDraftLine[];
}

/**
 * 発注の作成画面の初期値：受注のうち選んだ仕入先の商品の明細（数量は仕入単位に換算）、納入先は受注の販売先、
 * 納品希望日は受注の納品希望日。作れない場合（メーカー直でない、取消済み、すでに発注がある）は理由を返す。
 */
export const makerDirectDraft = defineQuery({
  permission: "purchaseOrders.manage",
  input: z.object({ salesOrderId: idSchema, supplierId: idSchema }),
  run(
    ctx,
    { salesOrderId, supplierId },
  ): { draft: MakerDirectDraft; error: null } | { draft: null; error: string } {
    const order = ctx.stores.salesOrders.get(salesOrderId);
    if (!order) return { draft: null, error: "受注が見つかりません" };
    const all = linesWithItems(ctx, order);
    const check = checkMakerDirectLink({
      salesOrder: order,
      supplierId,
      lineSupplierIds: all.map((l) => l.supplierId),
      destinationKind: "customer",
      destinationCustomerId: order.customerId,
      otherActiveOrders: otherActiveOrders(linkedOrders(ctx, order.id), supplierId, null),
    });
    if (!check.ok) return { draft: null, error: check.error.message };
    const lines = all.filter((l) => l.supplierId === supplierId);
    return {
      error: null,
      draft: {
        salesOrderId: order.id,
        salesOrderNumber: order.number,
        supplierId,
        supplierName: lines[0]?.item.supplierName ?? "",
        customerId: order.customerId,
        customerName: order.customerName,
        deliveryRequestedOn: order.deliveryRequestedOn,
        lines: lines.map(({ line, item }): MakerDirectDraftLine => {
          const converted = purchaseQuantityFor(line.quantity, item.unitsPerPurchaseUnit);
          return {
            itemId: item.id,
            itemCode: item.code,
            itemName: item.name,
            salesQuantity: line.quantity,
            salesUnitName: item.salesUnitName,
            quantity: converted.quantity,
            purchaseUnitName: item.purchaseUnitName,
            unitsPerPurchaseUnit: item.unitsPerPurchaseUnit,
            orderedUnits: stockQuantity(converted.quantity, item.unitsPerPurchaseUnit),
            surplusUnits: converted.surplusUnits,
            unitPriceCenti: item.inputPriceOnOrder ? null : item.purchasePriceCenti,
          };
        }),
      },
    };
  },
});
