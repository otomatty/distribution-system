import { err, ok, type Result } from "../../domain/result";
/**
 * 在庫の記録（要件定義書 3.4）。在庫を動かすユースケースは、すべてここの関数を通す。
 *
 * - 台帳（stock_ledger）は追記のみ。誤りは打ち消しの行（reverses_id で元の行を指す）で直す
 * - 台帳への追記と集計表（stock_balances）の更新は、呼び出したユースケースと同じトランザクションで行う
 * - 現在庫がマイナスになる記録は insufficient_stock で失敗する（ユースケースが err を返せば全体が取り消される）
 * - 出荷可能数 = 現在庫 − 引当数。引当は現在庫を超えてもよい（受注は警告だけで登録できる）が、0 未満にはならない
 *
 * 使い方（ほかの区分のユースケースから）：
 *
 * ```ts
 * // 入荷：受入数 × 入数を保管場所に加える
 * const r = postStock(ctx, { sourceType: "receipt", sourceId: receiptId, businessDate: receivedOn }, [
 *   { itemId, locationId, quantity: stockQuantity(accepted, unitsPerPurchaseUnit), reason: "receipt" },
 * ]);
 * if (!r.ok) return r;
 *
 * // 入荷の取消・発送の取消：その伝票で動かした在庫を、打ち消しの行で戻す
 * const back = reverseStock(ctx, { sourceType: "receipt", sourceId: receiptId, businessDate: ctx.clock.today() });
 * if (!back.ok) return back; // 戻すとマイナスになるなら insufficient_stock
 *
 * // 受注の登録・編集・取消：引当の差分を反映する（domain/stock の allocationDelta で差分を作る）
 * const a = changeAllocation(ctx, allocationDelta(beforeLines, afterLines));
 * if (!a.ok) return a;
 *
 * // 発送：引当を外して、在庫を減らす（同じトランザクションで2つを呼ぶ）
 * changeAllocation(ctx, lines.map((l) => ({ itemId: l.itemId, locationId, quantity: -l.quantity })));
 * postStock(ctx, { sourceType: "shipment", sourceId: shipmentId, businessDate: shippedOn },
 *   lines.map((l) => ({ itemId: l.itemId, locationId, quantity: -l.quantity, reason: "shipment" })));
 * ```
 *
 * 商品と保管場所が存在することは、呼び出す側で確かめてから渡す。
 * 在庫不足の画面表示は、エラーの details をクエリ "stock.shortages" に渡すと商品名・保管場所名つきで返る。
 */
import {
  applyAllocationChanges,
  applyMovements,
  available,
  openEntries,
  type StockMovement,
  type StockReason,
  type StockSourceType,
} from "../../domain/stock";
import type { QueryContext, UsecaseContext } from "../core";
import type { LedgerEntry } from "./ledger.port";

/** 在庫を記録するのに使うもの。コマンドの ctx をそのまま渡せる */
export type StockWriteContext = Pick<UsecaseContext, "actor" | "clock" | "ids" | "stores">;
/** 在庫を読むのに使うもの。コマンド・クエリの ctx をそのまま渡せる */
export type StockReadContext = Pick<QueryContext, "stores">;

/** 在庫を動かした伝票 */
export interface StockSource {
  readonly sourceType: StockSourceType;
  /** 伝票の ID（入荷・発送・返品伝票・在庫操作などの ID） */
  readonly sourceId: string;
  /** 台帳に記録する業務日（入荷日・発送日・取消日など） */
  readonly businessDate: string;
  readonly memo?: string | null | undefined;
}

/** 在庫の増減1件。quantity は販売単位の符号つき整数（増は正、減は負）。0 の行は記録しない */
export interface StockPosting {
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: number;
  readonly reason: StockReason;
}

/** 商品×保管場所の在庫の状態 */
export interface StockLevel {
  readonly onHand: number;
  readonly allocated: number;
  /** 出荷可能数 = 現在庫 − 引当数（引当が現在庫を超えるとマイナスになる） */
  readonly available: number;
}

function notInteger(): Result<never> {
  return err("validation", "在庫の増減は整数で指定してください");
}

/** 台帳に書き、集計表の現在庫を更新する（マイナスの確認は済ませてから呼ぶ） */
function write(
  ctx: StockWriteContext,
  entries: readonly LedgerEntry[],
): Result<{ entryIds: string[] }> {
  const applied = applyMovements(entries, (itemId, locationId) =>
    ctx.stores.stock.balance(itemId, locationId),
  );
  if (!applied.ok) return applied;
  ctx.stores.stock.append(entries);
  const at = ctx.clock.now().toISOString();
  for (const b of applied.value) ctx.stores.stock.saveOnHand(b.itemId, b.locationId, b.onHand, at);
  return ok({ entryIds: entries.map((e) => e.id) });
}

/**
 * 在庫の増減を台帳に追記し、集計表の現在庫を更新する。
 * 同じ商品×保管場所の行はまとめて判定し、どれか1つでも現在庫がマイナスになれば何も記録せずに
 * insufficient_stock を返す（details は domain/stock の parseShortages で読める）。
 * 戻り値の entryIds は追記した台帳の行の ID。
 */
export function postStock(
  ctx: StockWriteContext,
  source: StockSource,
  postings: readonly StockPosting[],
): Result<{ entryIds: string[] }> {
  if (postings.some((p) => !Number.isSafeInteger(p.quantity))) return notInteger();
  const occurredAt = ctx.clock.now().toISOString();
  const entries: LedgerEntry[] = postings
    .filter((p) => p.quantity !== 0)
    .map((p) => ({
      id: ctx.ids.next(),
      occurredAt,
      businessDate: source.businessDate,
      itemId: p.itemId,
      locationId: p.locationId,
      quantity: p.quantity,
      reason: p.reason,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      reversesId: null,
      memo: source.memo ?? null,
      createdBy: ctx.actor.employeeId,
    }));
  return write(ctx, entries);
}

/**
 * 伝票で動かした在庫を、すべて打ち消しの行で戻す（入荷の取消、発送の取消など）。
 * まだ打ち消されていない行だけが対象で、2回呼んでも二重には戻さない（2回目は entryIds が空）。
 * 打ち消しの行は元の行と同じ理由・発生元で、数量の符号が逆になり、reverses_id で元の行を指す。
 * 戻した結果マイナスになる場合（入荷した在庫をもう出荷したなど）は insufficient_stock。
 */
export function reverseStock(
  ctx: StockWriteContext,
  source: StockSource,
): Result<{ entryIds: string[] }> {
  const open = openEntries(ctx.stores.stock.entriesBySource(source.sourceType, source.sourceId));
  const occurredAt = ctx.clock.now().toISOString();
  const entries: LedgerEntry[] = open.map((e) => ({
    id: ctx.ids.next(),
    occurredAt,
    businessDate: source.businessDate,
    itemId: e.itemId,
    locationId: e.locationId,
    quantity: -e.quantity,
    reason: e.reason,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    reversesId: e.id,
    memo: source.memo ?? null,
    createdBy: ctx.actor.employeeId,
  }));
  return write(ctx, entries);
}

/**
 * 引当数を増減する（quantity が正なら引き当て、負なら外す）。同じ商品×保管場所はまとめて判定する。
 * 現在庫を超える引当は許す。引当数が 0 未満になる場合は何も変えずに invalid_state を返す
 * （受注と引当の対応が崩れていることを示すので、黙って 0 にはしない）。
 */
export function changeAllocation(
  ctx: StockWriteContext,
  changes: readonly StockMovement[],
): Result<{ changed: number }> {
  if (changes.some((c) => !Number.isSafeInteger(c.quantity))) return notInteger();
  const applied = applyAllocationChanges(changes, (itemId, locationId) =>
    ctx.stores.stock.balance(itemId, locationId),
  );
  if (!applied.ok) return applied;
  const at = ctx.clock.now().toISOString();
  for (const b of applied.value)
    ctx.stores.stock.saveAllocated(b.itemId, b.locationId, b.allocated, at);
  return ok({ changed: applied.value.length });
}

function toLevel(balance: { onHand: number; allocated: number }): StockLevel {
  return { onHand: balance.onHand, allocated: balance.allocated, available: available(balance) };
}

/** 商品×保管場所の現在庫・引当数・出荷可能数（記録がなければすべて 0） */
export function stockLevel(ctx: StockReadContext, itemId: string, locationId: string): StockLevel {
  return toLevel(ctx.stores.stock.balance(itemId, locationId));
}

/**
 * ある保管場所での、複数の商品の現在庫・引当数・出荷可能数。
 * 記録のない商品も 0 で含める（受注の明細ごとの出荷可能数の表示や、超過の警告に使う）。
 */
export function stockLevels(
  ctx: StockReadContext,
  itemIds: readonly string[],
  locationId: string,
): Map<string, StockLevel> {
  const rows = new Map(
    ctx.stores.stock.balancesAt(locationId, itemIds).map((b) => [b.itemId, toLevel(b)]),
  );
  return new Map(
    itemIds.map((id) => [id, rows.get(id) ?? { onHand: 0, allocated: 0, available: 0 }]),
  );
}
