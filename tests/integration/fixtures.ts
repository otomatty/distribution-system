/** 結合テストのマスタのデータ（商品・保管場所など）をシステムの操作者で作る */
import { systemCommand } from "./helpers";

let counter = 0;

/** テストごとに重ならない名前 */
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

export async function createSupplier(name = uniqueName("テスト仕入先")): Promise<string> {
  const r = await systemCommand("partners.create", {
    name,
    kana: "テストシイレサキ",
    isSupplier: true,
  });
  return r.id;
}

export async function createLocation(name = uniqueName("テスト倉庫")): Promise<string> {
  const r = await systemCommand("locations.create", { name });
  return r.id;
}

export async function createRetailStore(name = uniqueName("テスト店舗")): Promise<string> {
  const r = await systemCommand("retailStores.create", { name });
  return r.id;
}

export async function createGenre(name = uniqueName("テストジャンル")): Promise<string> {
  const r = await systemCommand("genres.create", { name });
  return r.id;
}

export async function createItem(
  supplierId: string,
  overrides: Partial<{
    name: string;
    code: string;
    jan: string;
    genreId: string;
    reorderEnabled: boolean;
    reorderPoint: number;
  }> = {},
): Promise<{ id: string; code: string; name: string }> {
  const name = overrides.name ?? uniqueName("テスト商品");
  const r = await systemCommand("items.create", {
    name,
    supplierId,
    taxCategory: "reduced",
    purchaseUnitName: "ケース",
    salesUnitName: "個",
    unitsPerPurchaseUnit: 12,
    purchasePriceCenti: 120_000,
    salesPriceCenti: 15_050,
    ...overrides,
  });
  return { id: r.id, code: r.code, name };
}

/** 在庫を調整で入れる（初期在庫） */
export async function addInitialStock(
  locationId: string,
  lines: { itemId: string; quantity: number }[],
  operationDate = "2026-10-01",
): Promise<string> {
  const r = await systemCommand("stockOperations.create", {
    kind: "adjustment",
    reason: "initial",
    operationDate,
    locationId,
    lines,
  });
  return r.id;
}
