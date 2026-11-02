import type { TaxCategory } from "../../domain/money";
import type {
  DestinationKind,
  OrderSendMethod,
  PurchaseOrderStatus,
} from "../../domain/purchasing";
import type { WriteMeta } from "../ports";
import type { Page } from "../schemas";

/** 発注の項目（要件定義書 3.5）。合計は保存のたびに domain で計算した値 */
export interface PurchaseOrderFields {
  readonly supplierId: string;
  /** 発注日（業務日） */
  readonly orderedOn: string;
  /** 仕入先の担当者名（帳票の宛名に添える） */
  readonly supplierContactName: string | null;
  readonly destinationKind: DestinationKind;
  /** 納入先が保管場所のとき */
  readonly destinationLocationId: string | null;
  /** 納入先が販売先（メーカー直）のとき */
  readonly destinationCustomerId: string | null;
  /** 納入先がその他の届け先のとき（届け先の名前と住所。在庫に計上しない） */
  readonly destinationAddress: string | null;
  /** 社内の担当者 */
  readonly employeeId: string | null;
  readonly deliveryRequestedOn: string | null;
  readonly paymentDueOn: string | null;
  readonly sendMethod: OrderSendMethod;
  readonly memo: string | null;
  /** 明細の金額の合計（税抜・円） */
  readonly subtotal: number;
  readonly tax: number;
  /** 税込の合計（円） */
  readonly total: number;
}

/** 発注の明細。入数と税区分は発注時点の商品マスタの値を写す */
export interface PurchaseOrderLineFields {
  readonly itemId: string;
  /** 数量（仕入単位） */
  readonly quantity: number;
  /** 単価（仕入単位あたり、税抜、centi-yen） */
  readonly unitPriceCenti: number;
  readonly unitsPerPurchaseUnit: number;
  readonly taxCategory: TaxCategory;
  readonly memo: string | null;
}

export interface PurchaseOrderLineRecord extends PurchaseOrderLineFields {
  readonly id: string;
  readonly lineNo: number;
  /** これまでの受入数 + 返品数（その場で返したもの）の合計（仕入単位） */
  readonly receivedQuantity: number;
  /** 残りを打ち切ったか */
  readonly closed: boolean;
  readonly itemCode: string;
  readonly itemName: string;
  readonly jan: string | null;
  readonly purchaseUnitName: string;
  readonly salesUnitName: string;
}

export interface PurchaseOrderRecord extends PurchaseOrderFields {
  readonly id: string;
  readonly number: string;
  readonly status: PurchaseOrderStatus;
  readonly cancelReason: string | null;
  readonly confirmedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly supplierName: string;
  /** 仕入先の宛名と連絡先（発注書に載せる） */
  readonly supplier: {
    readonly honorific: string;
    readonly postalCode: string | null;
    readonly address: string | null;
    readonly phone: string | null;
    readonly fax: string | null;
  };
  /** 納入先の名前（保管場所名・販売先名。その他の届け先は null） */
  readonly destinationName: string | null;
  /** 納入先（保管場所・販売先）の連絡先。その他の届け先はすべて null */
  readonly destination: {
    readonly postalCode: string | null;
    readonly address: string | null;
    readonly phone: string | null;
  };
  readonly employeeName: string | null;
}

export interface PurchaseOrderDetail extends PurchaseOrderRecord {
  readonly lines: readonly PurchaseOrderLineRecord[];
}

export interface PurchaseOrderSummary extends PurchaseOrderRecord {
  readonly lineCount: number;
}

export interface PurchaseOrderFilter {
  readonly status?: PurchaseOrderStatus | undefined;
  readonly supplierId?: string | undefined;
  /** 発注日の範囲 */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** メモのあるものだけ */
  readonly hasMemo?: boolean | undefined;
  /** 発注番号・メモ・商品名・商品コードの部分一致 */
  readonly q?: string | undefined;
  /** 納品希望日がこの日より前で、まだ入荷が終わっていない（発注済み）もの */
  readonly deliveryBefore?: string | undefined;
}

export interface PurchaseOrderStore {
  get(id: string): PurchaseOrderDetail | undefined;
  insert(
    id: string,
    number: string,
    fields: PurchaseOrderFields,
    lines: readonly (PurchaseOrderLineFields & { id: string; lineNo: number })[],
    meta: WriteMeta,
  ): void;
  /** 版番号が一致したときだけ更新する。更新できたら true */
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<
      PurchaseOrderFields & {
        status: PurchaseOrderStatus;
        cancelReason: string | null;
        confirmedAt: string | null;
      }
    >,
    meta: WriteMeta,
  ): boolean;
  /**
   * 入荷・支払など、ほかの伝票の操作に伴う状態の変更（同じトランザクションで読んだ今の状態から、
   * domain の遷移関数で決めた状態にする）。版番号は1つ進める
   */
  setStatus(id: string, status: PurchaseOrderStatus, meta: WriteMeta): void;
  /** 作成中の発注の明細を入れ替える */
  replaceLines(
    orderId: string,
    lines: readonly (PurchaseOrderLineFields & { id: string; lineNo: number })[],
  ): void;
  /** 入荷・入荷の取消で、明細の入荷済みの数と打ち切りを保存する */
  saveLineProgress(
    lines: readonly { id: string; receivedQuantity: number; closed: boolean }[],
  ): void;
  /** 新しい順（発注日・番号） */
  list(filter: PurchaseOrderFilter, page: number, pageSize: number): Page<PurchaseOrderSummary>;
  count(filter: PurchaseOrderFilter): number;
}
