import type { StockBalance, StockReason, StockSourceType } from "../../domain/stock";
import type { Page } from "../schemas";

/** 在庫台帳の1行（追記のみ）。quantity は販売単位の符号つき整数 */
export interface LedgerEntry {
  readonly id: string;
  /** 記録した日時（UTC） */
  readonly occurredAt: string;
  /** 業務日（入荷日・発送日・操作日など、日本時間の YYYY-MM-DD） */
  readonly businessDate: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: number;
  readonly reason: StockReason;
  readonly sourceType: StockSourceType;
  readonly sourceId: string;
  /** 打ち消しの行なら、打ち消した元の行の ID */
  readonly reversesId: string | null;
  readonly memo: string | null;
  /** 記録した社員の ID */
  readonly createdBy: string;
}

export interface BalanceRow extends StockBalance {
  readonly itemId: string;
  readonly locationId: string;
}

/** 在庫一覧の1行（商品×保管場所） */
export interface StockListRow extends BalanceRow {
  readonly itemCode: string;
  readonly itemName: string;
  readonly jan: string | null;
  readonly salesUnitName: string;
  readonly genreName: string | null;
  readonly discontinued: boolean;
  readonly reorderEnabled: boolean;
  readonly reorderPoint: number;
  readonly locationName: string;
}

export interface StockListFilter {
  /** 商品名・商品コード・JAN の部分一致 */
  readonly q?: string | undefined;
  readonly locationId?: string | undefined;
  readonly genreId?: string | undefined;
  /** 指定した商品だけ（発注点割れの絞り込みに使う） */
  readonly itemIds?: readonly string[] | undefined;
}

/** 発注点管理をしている商品の、全保管場所の合計 */
export interface ReorderCandidate extends StockBalance {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly salesUnitName: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly reorderPoint: number;
}

/** 入荷予定数の計算に使う、発注済みで入荷が終わっていない発注明細（納入先が保管場所のもの） */
export interface OpenPurchaseLine {
  readonly itemId: string;
  readonly locationId: string;
  /** 発注数（仕入単位） */
  readonly quantity: number;
  /** 受入数 + 返品数の合計（仕入単位） */
  readonly receivedQuantity: number;
  readonly closed: boolean;
  readonly unitsPerPurchaseUnit: number;
}

export interface LedgerFilter {
  readonly locationId?: string | undefined;
  readonly reason?: StockReason | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** 在庫明細の1行。balance は、この行を記録した後の残高（保管場所を絞り込んだときはその場所の残高） */
export interface LedgerListRow extends LedgerEntry {
  readonly locationName: string;
  readonly createdByName: string | null;
  /** 発生元が在庫操作なら、その番号（SOP-2026-000001 など） */
  readonly sourceNumber: string | null;
  /** 打ち消し済みか */
  readonly reversed: boolean;
  readonly balance: number;
}

/**
 * 在庫台帳と集計表のポート。書き込みは usecases/stock/ledger.ts の関数からだけ行う
 * （台帳への追記と集計表の更新を同じトランザクションで行い、在庫がマイナスにならないことを確かめるため）。
 */
export interface StockStore {
  /** 集計表の値（行がなければ 0） */
  balance(itemId: string, locationId: string): StockBalance;
  /** ある保管場所の集計（itemIds を省くと、その保管場所のすべての行）。行のない商品は含めない */
  balancesAt(locationId: string, itemIds?: readonly string[]): BalanceRow[];
  /** ある商品の、すべての保管場所の集計 */
  balancesOfItem(itemId: string): BalanceRow[];
  saveOnHand(itemId: string, locationId: string, onHand: number, at: string): void;
  saveAllocated(itemId: string, locationId: string, allocated: number, at: string): void;
  append(entries: readonly LedgerEntry[]): void;
  entriesBySource(sourceType: StockSourceType, sourceId: string): LedgerEntry[];

  // ---- 画面用の照会 ----
  listBalances(filter: StockListFilter, page: number, pageSize: number): Page<StockListRow>;
  allBalances(filter: StockListFilter, limit: number): StockListRow[];
  reorderCandidates(): ReorderCandidate[];
  openPurchaseLines(itemIds?: readonly string[]): OpenPurchaseLine[];
  /** 期間の前の残高（opening）と、期間内の行（業務日・記録順） */
  ledger(
    itemId: string,
    filter: LedgerFilter,
    page: number,
    pageSize: number,
  ): { opening: number; rows: Page<LedgerListRow> };
}
