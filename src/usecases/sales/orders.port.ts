import type { TaxCategory } from "../../domain/money";
import type { SalesOrderStatus } from "../../domain/sales";
import type { WriteMeta } from "../ports";
import type { Page } from "../schemas";

/** 受注の見出しの項目（要件定義書 3.8） */
export interface SalesOrderHeader {
  readonly customerId: string;
  readonly orderedOn: string;
  /** 先方の担当者名 */
  readonly customerContactName: string | null;
  /** メーカー直（仕入先から販売先へ直送。引き当てず、在庫も動かさない） */
  readonly makerDirect: boolean;
  /** 出荷元の保管場所。メーカー直なら null */
  readonly locationId: string | null;
  /** 社内の担当者 */
  readonly employeeId: string | null;
  readonly deliveryRequestedOn: string | null;
  readonly shipPlannedOn: string;
  readonly memo: string | null;
}

/** 受注明細。単価（税抜・centi-yen）と税区分は受注時点の値を写して持つ */
export interface SalesOrderLineFields {
  readonly id: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly unitPriceCenti: number;
  /** 卸単価と違う単価にした理由 */
  readonly priceOverrideReason: string | null;
  readonly taxCategory: TaxCategory;
  readonly memo: string | null;
}

/** 送料など（税抜・円の単価 × 数量） */
export interface SalesChargeFields {
  readonly id: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitAmount: number;
  readonly taxCategory: TaxCategory;
  readonly memo: string | null;
}

export interface SalesOrderRecord extends SalesOrderHeader {
  readonly id: string;
  readonly number: string;
  readonly status: SalesOrderStatus;
  /** 分割元の受注 */
  readonly splitFromId: string | null;
  readonly cancelReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
}

export interface SalesOrderLineDetail extends SalesOrderLineFields {
  readonly lineNo: number;
  readonly itemCode: string;
  readonly itemName: string;
  readonly salesUnitName: string;
  readonly salesMinLot: number;
  /** 今の卸単価（商品マスタ） */
  readonly listPriceCenti: number;
  readonly discontinued: boolean;
}

export interface SalesOrderDetail extends SalesOrderRecord {
  readonly customerName: string;
  readonly customerHonorific: "御中" | "様";
  /** 販売先の郵便番号・住所（納品書の宛名に使う） */
  readonly customerPostalCode: string | null;
  readonly customerAddress: string | null;
  readonly locationName: string | null;
  readonly employeeName: string | null;
  readonly splitFromNumber: string | null;
  readonly lines: readonly SalesOrderLineDetail[];
  readonly charges: readonly SalesChargeFields[];
  /** この受注から分割した受注 */
  readonly splits: readonly { id: string; number: string; status: SalesOrderStatus }[];
}

export interface SalesOrderListRow extends SalesOrderRecord {
  readonly customerName: string;
  readonly locationName: string | null;
  readonly employeeName: string | null;
  readonly lineCount: number;
  /** 発送前で、明細のどれかの商品の引当数が保管場所の現在庫を超えている（出荷可能数が足りない） */
  readonly shortage: boolean;
}

export interface SalesOrderFilter {
  readonly status?: SalesOrderStatus | undefined;
  readonly customerId?: string | undefined;
  /** 保管場所の ID、または "maker"（メーカー直だけ） */
  readonly locationId?: string | undefined;
  readonly shipFrom?: string | undefined;
  readonly shipTo?: string | undefined;
  /** 受注番号・販売先名・先方担当者・メモ・商品名の部分一致 */
  readonly q?: string | undefined;
  /** 出荷可能数が足りない受注だけ */
  readonly shortage?: boolean | undefined;
}

/** 金額の計算に使う明細と送料（一覧の合計の表示用） */
export interface OrderAmountSources {
  readonly lines: readonly {
    readonly salesOrderId: string;
    readonly unitPriceCenti: number;
    readonly quantity: number;
    readonly taxCategory: TaxCategory;
  }[];
  readonly charges: readonly {
    readonly salesOrderId: string;
    readonly unitAmount: number;
    readonly quantity: number;
    readonly taxCategory: TaxCategory;
  }[];
}

/** 発送リスト・一括発送の対象（受注済みの受注と明細） */
export interface ShippingOrder {
  readonly id: string;
  readonly number: string;
  readonly version: number;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerKana: string;
  readonly customerHonorific: "御中" | "様";
  readonly locationId: string;
  readonly shipPlannedOn: string;
  readonly memo: string | null;
  readonly lines: readonly {
    readonly itemId: string;
    readonly itemCode: string;
    readonly itemName: string;
    readonly salesUnitName: string;
    readonly quantity: number;
    /** 保管場所の現在庫 */
    readonly onHand: number;
  }[];
}

export interface SalesDashboardCounts {
  /**
   * 出荷予定日が今日までの受注済みの受注（保管場所ごと。メーカー直は locationId が null）。
   * 発送リストと同じく、出荷予定日を過ぎた（遅れの）受注も含め、そのうちの件数を overdue に持つ
   */
  readonly shipPlanned: readonly {
    readonly locationId: string | null;
    readonly locationName: string;
    readonly count: number;
    readonly overdue: number;
  }[];
  /** 出荷可能数が足りない受注（発送前） */
  readonly shortage: number;
  /** 出荷予定日を過ぎても発送していない受注 */
  readonly overdue: number;
}

export interface SalesOrderStore {
  get(id: string): SalesOrderDetail | undefined;
  /** 出荷予定日の新しい順 */
  list(filter: SalesOrderFilter, page: number, pageSize: number): Page<SalesOrderListRow>;
  amountSources(orderIds: readonly string[]): OrderAmountSources;
  insert(
    order: SalesOrderHeader & {
      readonly id: string;
      readonly number: string;
      readonly status: SalesOrderStatus;
      readonly splitFromId: string | null;
    },
    lines: readonly SalesOrderLineFields[],
    charges: readonly SalesChargeFields[],
    meta: WriteMeta,
  ): void;
  /** 版番号が一致したときだけ見出しを更新し、版番号を上げる。更新できたら true */
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<SalesOrderHeader & { status: SalesOrderStatus; cancelReason: string | null }>,
    meta: WriteMeta,
  ): boolean;
  /** 明細を入れ替える（並びは渡した順。ID は呼び出し側で決める） */
  replaceLines(orderId: string, lines: readonly SalesOrderLineFields[]): void;
  replaceCharges(orderId: string, charges: readonly SalesChargeFields[]): void;
  /** 保管場所の受注済みの受注（メーカー直を除く）で、出荷予定日が date までのもの（受注番号の順） */
  forShipping(date: string, locationId: string): ShippingOrder[];
  /** 保管場所の発送済みの受注のうち、出荷予定日が date までで、date に発送した（有効な発送の発送日）ものの ID */
  shippedIds(date: string, locationId: string): string[];
  dashboard(today: string): SalesDashboardCounts;
}
