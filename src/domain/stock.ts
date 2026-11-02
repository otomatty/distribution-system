/** 在庫の台帳と集計のルール（要件定義書 3.4）。在庫数は販売単位の整数。 */
import { err, ok, type Result } from "./result";

export const STOCK_REASONS = {
  receipt: "入荷",
  shipment: "発送",
  sales_return: "返品戻し",
  purchase_return: "仕入返品",
  transfer_out: "移動（出）",
  transfer_in: "移動（入）",
  adjustment: "調整",
  sample: "サンプル",
  disposal: "処分",
  initial: "初期在庫",
  stocktake: "棚卸差異",
  store_transfer: "店舗払い出し",
} as const;

export type StockReason = keyof typeof STOCK_REASONS;

/** 在庫の増減1件（台帳の1行に対応）。quantity は符号つき。 */
export interface StockMovement {
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: number;
}

export interface StockBalance {
  readonly onHand: number;
  readonly allocated: number;
}

export interface Shortage {
  readonly itemId: string;
  readonly locationId: string;
  /** 足りない数（正の整数） */
  readonly shortBy: number;
}

export function balanceKey(itemId: string, locationId: string): string {
  return `${itemId}\u0000${locationId}`;
}

export function available(balance: StockBalance): number {
  return balance.onHand - balance.allocated;
}

/** 同じ商品×保管場所の増減をまとめる。0 になった組は除く。 */
export function netMovements(movements: readonly StockMovement[]): StockMovement[] {
  const map = new Map<string, StockMovement>();
  for (const m of movements) {
    if (!Number.isInteger(m.quantity)) throw new RangeError("在庫の増減は整数");
    const key = balanceKey(m.itemId, m.locationId);
    const prev = map.get(key);
    map.set(key, {
      itemId: m.itemId,
      locationId: m.locationId,
      quantity: (prev?.quantity ?? 0) + m.quantity,
    });
  }
  return [...map.values()].filter((m) => m.quantity !== 0);
}

/**
 * 増減を適用した後の現在庫を計算する。マイナスになる組があれば insufficient_stock を返す。
 * 現在の集計は getBalance で受け取る（未登録の組は 0）。
 */
export function applyMovements(
  movements: readonly StockMovement[],
  getBalance: (itemId: string, locationId: string) => StockBalance,
): Result<{ itemId: string; locationId: string; onHand: number }[]> {
  const results: { itemId: string; locationId: string; onHand: number }[] = [];
  const shortages: Shortage[] = [];
  for (const m of netMovements(movements)) {
    const current = getBalance(m.itemId, m.locationId);
    const onHand = current.onHand + m.quantity;
    if (onHand < 0)
      shortages.push({ itemId: m.itemId, locationId: m.locationId, shortBy: -onHand });
    results.push({ itemId: m.itemId, locationId: m.locationId, onHand });
  }
  if (shortages.length > 0) {
    return err("insufficient_stock", "在庫が足りません", {
      details: shortages.map((s) => `${s.itemId}\u0000${s.locationId}\u0000${s.shortBy}`),
    });
  }
  return ok(results);
}

/** insufficient_stock の details を Shortage に戻す。 */
export function parseShortages(details: readonly string[] | undefined): Shortage[] {
  return (details ?? []).flatMap((d) => {
    const [itemId, locationId, shortBy] = d.split("\u0000");
    return itemId && locationId && shortBy
      ? [{ itemId, locationId, shortBy: Number(shortBy) }]
      : [];
  });
}

export interface AllocationLine {
  readonly itemId: string;
  readonly locationId: string | null;
  readonly quantity: number;
}

/**
 * 受注の引当の差分。旧明細の引当を外し、新明細の引当を加える。
 * 保管場所のない明細（メーカー直）は引き当てない。
 */
export function allocationDelta(
  before: readonly AllocationLine[],
  after: readonly AllocationLine[],
): StockMovement[] {
  const moves: StockMovement[] = [];
  for (const l of before) {
    if (l.locationId)
      moves.push({ itemId: l.itemId, locationId: l.locationId, quantity: -l.quantity });
  }
  for (const l of after) {
    if (l.locationId)
      moves.push({ itemId: l.itemId, locationId: l.locationId, quantity: l.quantity });
  }
  return netMovements(moves);
}

/** 発注点割れ：出荷可能数 + 入荷予定数 < 発注点在庫数（要件定義書 3.13） */
export function isBelowReorderPoint(
  availableQty: number,
  incomingQty: number,
  reorderPoint: number,
): boolean {
  return availableQty + incomingQty < reorderPoint;
}

export type StockOperationKind = "adjustment" | "transfer" | "store_transfer" | "stocktake";

export const STOCK_OPERATION_LABELS: Readonly<Record<StockOperationKind, string>> = {
  adjustment: "調整",
  transfer: "移動",
  store_transfer: "店舗払い出し",
  stocktake: "棚卸",
};

export type AdjustmentReason = "adjustment" | "sample" | "disposal" | "initial";

export interface StockOperationLineInput {
  readonly itemId: string;
  /** 調整は符号つき、移動・払い出しは正の数、棚卸は実際の数 */
  readonly quantity: number;
}

/** 在庫操作伝票の明細を、台帳に記録する増減に変換する。 */
export function stockOperationMovements(
  op:
    | {
        kind: "adjustment";
        locationId: string;
        reason: AdjustmentReason;
        lines: readonly StockOperationLineInput[];
      }
    | {
        kind: "transfer";
        fromLocationId: string;
        toLocationId: string;
        lines: readonly StockOperationLineInput[];
      }
    | { kind: "store_transfer"; locationId: string; lines: readonly StockOperationLineInput[] }
    | {
        kind: "stocktake";
        locationId: string;
        lines: readonly StockOperationLineInput[];
        currentOnHand: (itemId: string) => number;
      },
): Result<{ itemId: string; locationId: string; quantity: number; reason: StockReason }[]> {
  if (op.lines.length === 0) return err("validation", "明細を1行以上入力してください");
  const seen = new Set<string>();
  for (const l of op.lines) {
    if (seen.has(l.itemId)) return err("validation", "同じ商品が複数の行にあります");
    seen.add(l.itemId);
    if (!Number.isInteger(l.quantity)) return err("validation", "数量は整数で入力してください");
  }
  switch (op.kind) {
    case "adjustment": {
      if (op.lines.some((l) => l.quantity === 0))
        return err("validation", "数量に0は指定できません");
      return ok(
        op.lines.map((l) => ({
          itemId: l.itemId,
          locationId: op.locationId,
          quantity: l.quantity,
          reason: op.reason,
        })),
      );
    }
    case "transfer": {
      if (op.fromLocationId === op.toLocationId)
        return err("validation", "移動元と移動先に同じ保管場所は指定できません");
      if (op.lines.some((l) => l.quantity <= 0))
        return err("validation", "移動する数量は1以上で入力してください");
      return ok(
        op.lines.flatMap((l) => [
          {
            itemId: l.itemId,
            locationId: op.fromLocationId,
            quantity: -l.quantity,
            reason: "transfer_out" as const,
          },
          {
            itemId: l.itemId,
            locationId: op.toLocationId,
            quantity: l.quantity,
            reason: "transfer_in" as const,
          },
        ]),
      );
    }
    case "store_transfer": {
      if (op.lines.some((l) => l.quantity <= 0))
        return err("validation", "払い出す数量は1以上で入力してください");
      return ok(
        op.lines.map((l) => ({
          itemId: l.itemId,
          locationId: op.locationId,
          quantity: -l.quantity,
          reason: "store_transfer" as const,
        })),
      );
    }
    case "stocktake":
      break;
  }
  // 棚卸：実際の数との差を記録する
  if (op.lines.some((l) => l.quantity < 0))
    return err("validation", "実際の数は0以上で入力してください");
  return ok(
    op.lines
      .map((l) => ({
        itemId: l.itemId,
        locationId: op.locationId,
        quantity: l.quantity - op.currentOnHand(l.itemId),
        reason: "stocktake" as const,
      }))
      .filter((m) => m.quantity !== 0),
  );
}
