/**
 * メーカー直の受注からの発注（要件定義書 3.8 Should、6章 sales_orders ↔ purchase_orders）。
 * 受注の明細を仕入先ごとにまとめ、仕入先ごとに1枚の発注を作る。納入先は受注の販売先。
 * 受注の数量は販売単位、発注の数量は仕入単位なので、入数で割って端数を切り上げる。
 */
import type { DestinationKind, PurchaseOrderStatus } from "./purchasing";
import { err, ok, type Result } from "./result";
import type { SalesOrderStatus } from "./sales";

export interface PurchaseQuantity {
  /** 発注の数量（仕入単位） */
  readonly quantity: number;
  /** 切り上げで受注より多くなる数（販売単位）。割り切れれば 0 */
  readonly surplusUnits: number;
}

/**
 * 受注の数量（販売単位）を発注の数量（仕入単位）にする。端数は切り上げる（仕入単位より細かくは発注できない）。
 * 例：受注 25個、入数 12 → 発注 3ケース（36個。11個多い）
 */
export function purchaseQuantityFor(
  salesQuantity: number,
  unitsPerPurchaseUnit: number,
): PurchaseQuantity {
  if (!Number.isInteger(salesQuantity) || salesQuantity < 1)
    throw new RangeError("受注の数量は1以上の整数");
  if (!Number.isInteger(unitsPerPurchaseUnit) || unitsPerPurchaseUnit < 1)
    throw new RangeError("入数は1以上の整数");
  const quantity = Math.ceil(salesQuantity / unitsPerPurchaseUnit);
  return { quantity, surplusUnits: quantity * unitsPerPurchaseUnit - salesQuantity };
}

/** 明細を仕入先ごとにまとめる（仕入先は最初に出てきた順、明細は元の順） */
export function groupBySupplier<L extends { readonly supplierId: string }>(
  lines: readonly L[],
): { supplierId: string; lines: L[] }[] {
  const groups = new Map<string, L[]>();
  for (const l of lines) {
    const list = groups.get(l.supplierId) ?? [];
    list.push(l);
    groups.set(l.supplierId, list);
  }
  return [...groups.entries()].map(([supplierId, list]) => ({ supplierId, lines: list }));
}

/** 受注に結びついた発注のうち、取り消していないもの（同じ仕入先に2枚目を作らないための判定に使う） */
export function isActiveLinkedOrder(status: PurchaseOrderStatus): boolean {
  return status !== "cancelled";
}

/** 受注の状態から、メーカー直の発注を作れるか（取り消した受注・メーカー直でない受注からは作れない） */
export function canOrderFromSalesOrder(order: {
  readonly makerDirect: boolean;
  readonly status: SalesOrderStatus;
}): Result<true> {
  if (!order.makerDirect) return err("invalid_state", "メーカー直の受注からだけ、発注を作れます");
  if (order.status === "cancelled")
    return err("invalid_state", "取り消した受注からは発注を作れません");
  return ok(true);
}

export interface MakerDirectLinkCheck {
  readonly salesOrder: {
    readonly makerDirect: boolean;
    readonly status: SalesOrderStatus;
    readonly customerId: string;
  };
  /** 発注の仕入先 */
  readonly supplierId: string;
  /** 受注の明細の商品の仕入先 */
  readonly lineSupplierIds: readonly string[];
  readonly destinationKind: DestinationKind;
  readonly destinationCustomerId: string | null;
  /** この受注・この仕入先の、取り消していないほかの発注の番号 */
  readonly otherActiveOrders: readonly string[];
}

/** 受注に結びついた発注の納入先は、受注の販売先（作るときも、作成中の発注を編集するときも） */
export function checkMakerDirectDestination(
  destinationKind: DestinationKind,
  destinationCustomerId: string | null,
  salesOrderCustomerId: string,
): Result<true> {
  if (destinationKind === "customer" && destinationCustomerId === salesOrderCustomerId)
    return ok(true);
  const message = "メーカー直の受注から作る発注の納入先は、受注の販売先にしてください";
  return err("validation", message, { fields: [{ field: "destinationCustomerId", message }] });
}

/**
 * 受注に結びつける発注を作るときの検証：メーカー直で取り消していない受注、その受注の明細にある仕入先、
 * 納入先は受注の販売先、同じ受注・同じ仕入先の発注は1枚だけ（二重に発注しない）。
 */
export function checkMakerDirectLink(input: MakerDirectLinkCheck): Result<true> {
  const state = canOrderFromSalesOrder(input.salesOrder);
  if (!state.ok) return state;
  if (!input.lineSupplierIds.includes(input.supplierId))
    return err("validation", "この受注に、この仕入先の商品はありません", {
      fields: [{ field: "supplierId", message: "この受注に、この仕入先の商品はありません" }],
    });
  const destination = checkMakerDirectDestination(
    input.destinationKind,
    input.destinationCustomerId,
    input.salesOrder.customerId,
  );
  if (!destination.ok) return destination;
  const [existing] = input.otherActiveOrders;
  if (existing !== undefined)
    return err(
      "duplicate",
      `この受注のこの仕入先への発注はすでにあります（${existing}）。作り直すときは先に取り消してください`,
    );
  return ok(true);
}
