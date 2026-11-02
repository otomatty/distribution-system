/** 受注・発送の結合テストのデータ（販売先・商品・在庫・受注）をシステムの操作者で作る */
import { toBusinessDate } from "../../src/domain/dates";
import type { CommandInput } from "../../src/usecases/registry";
import { addInitialStock, createLocation, createSupplier, uniqueName } from "./fixtures";
import { systemCommand, systemQuery } from "./helpers";

export function today(): string {
  return toBusinessDate(new Date());
}

export async function createCustomer(
  fields: { name?: string; deliveryDays?: number; honorific?: "御中" | "様" } = {},
): Promise<{ id: string; name: string }> {
  const name = fields.name ?? uniqueName("テスト販売先");
  const r = await systemCommand("partners.create", {
    name,
    kana: uniqueName("テストハンバイサキ"),
    isCustomer: true,
    honorific: fields.honorific ?? "御中",
    deliveryDays: fields.deliveryDays ?? 0,
    postalCode: "0220002",
    address: "岩手県大船渡市大船渡町1-1",
  });
  return { id: r.id, name };
}

export interface TestItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export async function createSalesItem(
  supplierId: string,
  fields: {
    name?: string;
    salesPriceCenti?: number;
    taxCategory?: "standard" | "reduced";
    salesMinLot?: number;
  } = {},
): Promise<TestItem> {
  const name = fields.name ?? uniqueName("テスト菓子");
  const r = await systemCommand("items.create", {
    name,
    supplierId,
    taxCategory: fields.taxCategory ?? "reduced",
    purchaseUnitName: "ケース",
    salesUnitName: "個",
    unitsPerPurchaseUnit: 12,
    purchasePriceCenti: 120_000,
    salesPriceCenti: fields.salesPriceCenti ?? 15_050,
    salesMinLot: fields.salesMinLot ?? 1,
  });
  return { id: r.id, code: r.code, name };
}

/** 仕入先・商品2つ（軽減・標準）・保管場所・販売先を作り、保管場所に在庫を入れる */
export async function salesSetup(stock: { a?: number; b?: number } = {}) {
  const supplierId = await createSupplier();
  const a = await createSalesItem(supplierId, { taxCategory: "reduced", salesPriceCenti: 15_050 });
  const b = await createSalesItem(supplierId, {
    taxCategory: "standard",
    salesPriceCenti: 10_000,
    salesMinLot: 6,
  });
  const locationId = await createLocation();
  const customer = await createCustomer();
  const lines = [
    { itemId: a.id, quantity: stock.a ?? 10 },
    { itemId: b.id, quantity: stock.b ?? 12 },
  ].filter((l) => l.quantity > 0);
  if (lines.length > 0) await addInitialStock(locationId, lines);
  return { supplierId, a, b, locationId, customer };
}

type CreateInput = CommandInput<"salesOrders.create">;

export async function createOrder(
  input: Partial<CreateInput> & Pick<CreateInput, "customerId" | "lines">,
): Promise<{ id: string; number: string }> {
  return systemCommand("salesOrders.create", {
    orderedOn: today(),
    shipPlannedOn: today(),
    ...input,
  });
}

export async function level(itemId: string, locationId: string) {
  const levels = await systemQuery("stock.levels", { itemIds: [itemId], locationId });
  const l = levels[0];
  return { onHand: l?.onHand ?? 0, allocated: l?.allocated ?? 0, available: l?.available ?? 0 };
}

export async function getOrder(id: string) {
  const view = await systemQuery("salesOrders.get", { id });
  if (!view) throw new Error(`order ${id} not found`);
  return view;
}
