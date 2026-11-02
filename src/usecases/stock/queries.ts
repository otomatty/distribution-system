/** 在庫の照会（要件定義書 3.4・3.13）：在庫一覧、商品ごとの在庫明細、出荷可能数、在庫不足の内容、発注点割れ */
import { z } from "zod";

import { remainingQuantity, stockQuantity } from "../../domain/purchasing";
import {
  available,
  balanceKey,
  isBelowReorderPoint,
  isStockReason,
  parseShortages,
  STOCK_REASONS,
  type StockReason,
} from "../../domain/stock";
import { defineQuery } from "../core";
import type { ItemRecord } from "../masters/items.port";
import type { Stores } from "../ports";
import { idSchema, optionalBusinessDate, pageInput, type Page } from "../schemas";
import { stockLevels, type StockLevel } from "./ledger";
import type { OpenPurchaseLine, StockListFilter, StockListRow } from "./ledger.port";

/** 入荷予定数（販売単位）を商品×保管場所ごとに合計する */
function incomingByKey(lines: readonly OpenPurchaseLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    const qty = stockQuantity(remainingQuantity({ id: "", ...l }), l.unitsPerPurchaseUnit);
    if (qty === 0) continue;
    const key = balanceKey(l.itemId, l.locationId);
    out.set(key, (out.get(key) ?? 0) + qty);
  }
  return out;
}

export interface ReorderAlert {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly salesUnitName: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly reorderPoint: number;
  /** 全保管場所の出荷可能数の合計 */
  readonly available: number;
  /** 全保管場所の入荷予定数の合計（販売単位） */
  readonly incoming: number;
}

/** 発注点割れの商品：出荷可能数 + 入荷予定数 < 発注点在庫数（発注点管理をしている商品だけ） */
function reorderAlerts(stores: Stores): ReorderAlert[] {
  const candidates = stores.stock.reorderCandidates();
  if (candidates.length === 0) return [];
  const incoming = new Map<string, number>();
  for (const l of stores.stock.openPurchaseLines(candidates.map((c) => c.itemId))) {
    const qty = stockQuantity(remainingQuantity({ id: "", ...l }), l.unitsPerPurchaseUnit);
    incoming.set(l.itemId, (incoming.get(l.itemId) ?? 0) + qty);
  }
  return candidates.flatMap((c) => {
    const avail = available(c);
    const inc = incoming.get(c.itemId) ?? 0;
    if (!isBelowReorderPoint(avail, inc, c.reorderPoint)) return [];
    return [
      {
        itemId: c.itemId,
        itemCode: c.itemCode,
        itemName: c.itemName,
        salesUnitName: c.salesUnitName,
        supplierId: c.supplierId,
        supplierName: c.supplierName,
        reorderPoint: c.reorderPoint,
        available: avail,
        incoming: inc,
      },
    ];
  });
}

export interface StockListItem extends StockListRow {
  readonly available: number;
  /** この保管場所への入荷予定数（販売単位） */
  readonly incoming: number;
  /** 商品として発注点割れか（全保管場所の合計で判定） */
  readonly belowReorderPoint: boolean;
}

const listFilterInput = {
  q: z.string().max(100).optional(),
  locationId: z.string().max(64).optional(),
  genreId: z.string().max(64).optional(),
  /** 発注点割れの商品だけ */
  belowReorder: z.boolean().default(false),
};

function decorate(stores: Stores, rows: readonly StockListRow[], alerts: ReadonlySet<string>) {
  const incoming = incomingByKey(
    stores.stock.openPurchaseLines([...new Set(rows.map((r) => r.itemId))]),
  );
  return rows.map((r): StockListItem => ({
    ...r,
    available: available(r),
    incoming: incoming.get(balanceKey(r.itemId, r.locationId)) ?? 0,
    belowReorderPoint: alerts.has(r.itemId),
  }));
}

/** 絞り込みの条件を、発注点割れの商品に置き換える。該当がなければ undefined（結果は空） */
function storeFilter(
  filter: {
    q?: string | undefined;
    locationId?: string | undefined;
    genreId?: string | undefined;
    belowReorder: boolean;
  },
  alerts: ReadonlySet<string>,
): StockListFilter | undefined {
  const { belowReorder, ...rest } = filter;
  if (!belowReorder) return rest;
  if (alerts.size === 0) return undefined;
  return { ...rest, itemIds: [...alerts] };
}

/** 在庫一覧（商品×保管場所の現在庫・引当数・出荷可能数・入荷予定数・発注点割れ） */
export const listStock = defineQuery({
  permission: "view",
  input: pageInput.extend(listFilterInput),
  run(ctx, { page, pageSize, ...filter }): Page<StockListItem> {
    const alerts = new Set(reorderAlerts(ctx.stores).map((a) => a.itemId));
    const f = storeFilter(filter, alerts);
    if (!f) return { rows: [], total: 0, page, pageSize };
    const result = ctx.stores.stock.listBalances(f, page, pageSize);
    return { ...result, rows: decorate(ctx.stores, result.rows, alerts) };
  },
});

/** CSV 出力用：在庫一覧と同じ条件のすべての行（最大 20,000 行） */
export const exportStock = defineQuery({
  permission: "view",
  input: z.object(listFilterInput),
  run(ctx, filter): StockListItem[] {
    const alerts = new Set(reorderAlerts(ctx.stores).map((a) => a.itemId));
    const f = storeFilter(filter, alerts);
    if (!f) return [];
    return decorate(ctx.stores, ctx.stores.stock.allBalances(f, 20_000), alerts);
  },
});

/** 発注点割れの商品の一覧（ダッシュボードの「発注点割れの商品」に使う） */
export const listReorderAlerts = defineQuery({
  permission: "view",
  input: z.object({}),
  run(ctx): ReorderAlert[] {
    return reorderAlerts(ctx.stores);
  },
});

export interface ItemStockLocation extends StockLevel {
  readonly locationId: string;
  readonly locationName: string;
  readonly incoming: number;
}

/** 在庫明細の見出し：商品と、保管場所ごとの在庫 */
export const getItemStock = defineQuery({
  permission: "view",
  input: z.object({ itemId: idSchema }),
  run(
    ctx,
    { itemId },
  ): {
    item: ItemRecord;
    locations: ItemStockLocation[];
    belowReorderPoint: boolean;
  } | null {
    const item = ctx.stores.items.get(itemId);
    if (!item) return null;
    const names = new Map(ctx.stores.locations.list(true).map((l) => [l.id, l.name]));
    const incoming = incomingByKey(ctx.stores.stock.openPurchaseLines([itemId]));
    const keys = new Set<string>();
    const locations: ItemStockLocation[] = ctx.stores.stock.balancesOfItem(itemId).map((b) => {
      keys.add(b.locationId);
      return {
        locationId: b.locationId,
        locationName: names.get(b.locationId) ?? "",
        onHand: b.onHand,
        allocated: b.allocated,
        available: available(b),
        incoming: incoming.get(balanceKey(itemId, b.locationId)) ?? 0,
      };
    });
    // 在庫の記録はまだないが、入荷予定がある保管場所
    for (const [key, qty] of incoming) {
      const locationId = key.split("\u0000")[1] ?? "";
      if (keys.has(locationId)) continue;
      locations.push({
        locationId,
        locationName: names.get(locationId) ?? "",
        onHand: 0,
        allocated: 0,
        available: 0,
        incoming: qty,
      });
    }
    const belowReorderPoint = reorderAlerts(ctx.stores).some((a) => a.itemId === itemId);
    return { item, locations, belowReorderPoint };
  },
});

const REASON_KEYS: StockReason[] = Object.keys(STOCK_REASONS).filter(isStockReason);

/** 在庫明細（商品ごとの台帳）。期間・保管場所・理由で絞り込み、各行の後の残高を返す */
export const listLedger = defineQuery({
  permission: "view",
  input: z.object({
    itemId: idSchema,
    locationId: z.string().max(64).optional(),
    reason: z.enum(REASON_KEYS).optional(),
    from: optionalBusinessDate,
    to: optionalBusinessDate,
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(500).default(100),
  }),
  run(ctx, { itemId, page, pageSize, from, to, ...filter }) {
    return ctx.stores.stock.ledger(
      itemId,
      { ...filter, from: from ?? undefined, to: to ?? undefined },
      page,
      pageSize,
    );
  },
});

/** ある保管場所での商品ごとの現在庫・引当数・出荷可能数（受注の明細の出荷可能数の表示などに使う） */
export const getStockLevels = defineQuery({
  permission: "view",
  input: z.object({ itemIds: z.array(idSchema).max(500), locationId: idSchema }),
  run(ctx, { itemIds, locationId }) {
    return [...stockLevels(ctx, itemIds, locationId)].map(([itemId, level]) => ({
      itemId,
      onHand: level.onHand,
      allocated: level.allocated,
      available: level.available,
    }));
  },
});

export interface ShortageDetail {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly salesUnitName: string;
  readonly locationId: string;
  readonly locationName: string;
  /** 足りない数（販売単位） */
  readonly shortBy: number;
  /** 今の現在庫 */
  readonly onHand: number;
}

/**
 * 在庫不足（insufficient_stock）のエラーの details を、画面に出せる形にする。
 * 画面では `runQuery(c, "stock.shortages", { details: error.details ?? [] })` の結果を表示する。
 */
export const describeShortages = defineQuery({
  permission: "view",
  input: z.object({ details: z.array(z.string().max(200)).max(500) }),
  run(ctx, { details }): ShortageDetail[] {
    const shortages = parseShortages(details);
    const items = new Map(
      ctx.stores.items.getMany(shortages.map((s) => s.itemId)).map((i) => [i.id, i]),
    );
    const names = new Map(ctx.stores.locations.list(true).map((l) => [l.id, l.name]));
    return shortages.map((s) => {
      const item = items.get(s.itemId);
      return {
        itemId: s.itemId,
        locationId: s.locationId,
        shortBy: s.shortBy,
        itemCode: item?.code ?? "",
        itemName: item?.name ?? "（不明な商品）",
        salesUnitName: item?.salesUnitName ?? "",
        locationName: names.get(s.locationId) ?? "",
        onHand: ctx.stores.stock.balance(s.itemId, s.locationId).onHand,
      };
    });
  },
});
