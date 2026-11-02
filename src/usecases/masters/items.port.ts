import type { TemperatureZone } from "../../domain/items";
import type { TaxCategory } from "../../domain/money";
import type { WriteMeta } from "../ports";
import type { Page } from "../schemas";

/** 商品マスタの項目（要件定義書 3.2）。単価は税抜の centi-yen */
export interface ItemFields {
  readonly code: string;
  readonly jan: string | null;
  readonly name: string;
  readonly supplierId: string;
  readonly genreId: string | null;
  readonly temperatureZone: TemperatureZone;
  readonly taxCategory: TaxCategory;
  /** 仕入単位の名前（ケースなど） */
  readonly purchaseUnitName: string;
  /** 販売単位の名前（個など）。在庫はこの単位で数える */
  readonly salesUnitName: string;
  /** 入数：1仕入単位あたりの販売単位の数 */
  readonly unitsPerPurchaseUnit: number;
  /** 仕入価格（仕入単位あたり、税抜、centi-yen） */
  readonly purchasePriceCenti: number;
  /** 卸単価（販売単位あたり、税抜、centi-yen） */
  readonly salesPriceCenti: number;
  readonly purchaseMinLot: number;
  readonly salesMinLot: number;
  readonly leadTimeDays: number | null;
  readonly reorderEnabled: boolean;
  readonly reorderPoint: number;
  readonly purchaseShippingNote: string | null;
  readonly salesShippingNote: string | null;
  /** 発注時に仕入価格を入力する（相場で変わる商品など） */
  readonly inputPriceOnOrder: boolean;
  readonly memo: string | null;
}

export interface ItemRecord extends ItemFields {
  readonly id: string;
  readonly supplierName: string;
  readonly genreName: string | null;
  readonly discontinued: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ItemFilter {
  /** 商品名・商品コード・JAN の部分一致 */
  readonly q?: string | undefined;
  readonly supplierId?: string | undefined;
  readonly genreId?: string | undefined;
  readonly includeDiscontinued?: boolean | undefined;
  /** 指定した ID を結果から除く（商品選択ダイアログで選択済みのもの） */
  readonly excludeIds?: readonly string[] | undefined;
}

export interface ItemStore {
  get(id: string): ItemRecord | undefined;
  /** 指定した ID の商品（見つからない ID は含めない）。並び順は ids の順 */
  getMany(ids: readonly string[]): ItemRecord[];
  findByCode(code: string): ItemRecord | undefined;
  /** 商品コードの順 */
  list(filter: ItemFilter, page: number, pageSize: number): Page<ItemRecord>;
  insert(id: string, fields: ItemFields, meta: WriteMeta): void;
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<ItemFields & { discontinued: boolean }>,
    meta: WriteMeta,
  ): boolean;
  /** 取引（在庫台帳・発注・受注・入荷・返品・廃棄・在庫操作）で使われているか */
  isUsed(id: string): boolean;
  delete(id: string): void;
}
