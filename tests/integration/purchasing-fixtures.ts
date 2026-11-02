/** 仕入の結合テストのデータ（発注・入荷など）をシステムの操作者で作る */
import { createItem, createLocation, createSupplier, uniqueName } from "./fixtures";
import { newKey, systemCommand, systemQuery } from "./helpers";

/** 取引条件（月末締め翌月末払い）のある仕入先 */
export async function createSupplierWithTerms(
  terms = { closingDay: 31, paymentMonthOffset: 1, paymentDay: 31 },
): Promise<string> {
  const id = await createSupplier();
  await systemCommand("partners.updateTerms", { id, version: 1, terms });
  return id;
}

export async function createCustomer(name = uniqueName("テスト販売先")): Promise<string> {
  const r = await systemCommand("partners.create", {
    name,
    kana: "テストハンバイサキ",
    isCustomer: true,
    address: "岩手県大船渡市盛町1-1",
  });
  return r.id;
}

/** 仕入先・保管場所・商品2つ（入数12、仕入価格1,200円/ケース、軽減税率） */
export async function purchasingSetup() {
  const supplierId = await createSupplier();
  const locationId = await createLocation();
  const a = await createItem(supplierId);
  const b = await createItem(supplierId);
  return { supplierId, locationId, a, b };
}

export async function createOrder(input: {
  supplierId: string;
  locationId?: string;
  customerId?: string;
  lines: { itemId: string; quantity: number; unitPriceCenti?: number }[];
  orderedOn?: string;
  deliveryRequestedOn?: string;
  memo?: string;
}): Promise<{ id: string; number: string }> {
  return systemCommand("purchaseOrders.create", {
    supplierId: input.supplierId,
    orderedOn: input.orderedOn ?? "2026-10-01",
    destinationKind: input.customerId ? "customer" : "location",
    destinationLocationId: input.locationId ?? null,
    destinationCustomerId: input.customerId ?? null,
    deliveryRequestedOn: input.deliveryRequestedOn ?? null,
    memo: input.memo ?? "",
    lines: input.lines.map((l) => ({
      itemId: l.itemId,
      quantity: l.quantity,
      unitPriceCenti: l.unitPriceCenti ?? 120_000,
      memo: "",
    })),
  });
}

export async function orderView(id: string) {
  const view = await systemQuery("purchaseOrders.get", { id });
  if (!view) throw new Error("発注が見つかりません");
  return view;
}

/** 作成して確定する（送付しない） */
export async function createConfirmedOrder(input: Parameters<typeof createOrder>[0]) {
  const po = await createOrder(input);
  await systemCommand("purchaseOrders.confirm", {
    id: po.id,
    version: 1,
    sendMethod: "none",
    recipient: null,
  });
  return po;
}

/** 入荷を記録する（受入数は明細の順） */
export async function receive(
  orderId: string,
  accepted: readonly number[],
  options: { receivedOn?: string; returned?: readonly number[]; close?: readonly boolean[] } = {},
) {
  const view = await orderView(orderId);
  return systemCommand("receipts.record", {
    purchaseOrderId: orderId,
    version: view.order.version,
    receivedOn: options.receivedOn ?? "2026-10-10",
    lines: view.order.lines.map((l, i) => ({
      lineId: l.id,
      accepted: accepted[i] ?? 0,
      returned: options.returned?.[i] ?? 0,
      closeRemaining: options.close?.[i] ?? false,
    })),
  });
}

export async function onHand(itemId: string, locationId: string): Promise<number> {
  const levels = await systemQuery("stock.levels", { itemIds: [itemId], locationId });
  return levels[0]?.onHand ?? 0;
}

/** 入荷確認の画面のフォーム（受入数・返品数・打ち切りは明細の ID ごと） */
export function receiveForm(
  view: Awaited<ReturnType<typeof orderView>>,
  values: Record<string, { accepted?: string; returned?: string; close?: boolean }>,
  extra: Record<string, string> = {},
): Record<string, string | string[]> {
  const form: Record<string, string | string[]> = {
    _key: newKey(),
    version: String(view.order.version),
    receivedOn: "2026-10-12",
    memo: "",
    lineId: view.order.lines.map((l) => l.id),
    ...extra,
  };
  for (const l of view.order.lines) {
    const v = values[l.id] ?? {};
    form[`accepted_${l.id}`] = v.accepted ?? "0";
    form[`returned_${l.id}`] = v.returned ?? "0";
    if (v.close) form[`close_${l.id}`] = "on";
  }
  return form;
}
