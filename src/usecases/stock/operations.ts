/**
 * 在庫操作（要件定義書 3.4）：調整・移動・店舗払い出しを伝票の形で、複数の商品をまとめて記録する。
 * 初期在庫は理由「初期在庫」の調整で入れる。記録した伝票は編集できない（誤りは逆の操作で直す）。
 */
import { z } from "zod";

import { err, ok, type Result } from "../../domain/result";
import {
  ADJUSTMENT_REASONS,
  stockOperationMovements,
  type StockOperationKind,
} from "../../domain/stock";
import { defineCommand, defineQuery, type UsecaseContext } from "../core";
import { businessDate, idSchema, optionalText, pageInput } from "../schemas";
import { postStock } from "./ledger";
import type { StockOperationDetail, StockOperationFields } from "./operations.port";

const quantityInput = z
  .number({ error: "数量は数字で入力してください" })
  .int("数量は整数で入力してください")
  .min(-9_999_999, "数量が大きすぎます")
  .max(9_999_999, "数量が大きすぎます");

export const operationLinesInput = z
  .array(z.object({ itemId: idSchema, quantity: quantityInput }))
  .min(1, "商品を1つ以上追加してください")
  .max(300, "1つの伝票に入れられる商品は300件までです");

const common = {
  operationDate: businessDate,
  locationId: idSchema,
  memo: optionalText(500),
  lines: operationLinesInput,
};

const createInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("adjustment"),
    reason: z.enum(ADJUSTMENT_REASONS, { error: "理由を選んでください" }),
    ...common,
  }),
  z.object({ kind: z.literal("transfer"), toLocationId: idSchema, ...common }),
  z.object({ kind: z.literal("store_transfer"), storeId: idSchema, ...common }),
]);

function fieldError(field: string, message: string): Result<never> {
  return err("validation", message, { fields: [{ field, message }] });
}

/** 保管場所が使えるか（取引終了の保管場所には記録しない） */
export function checkLocation(
  ctx: Pick<UsecaseContext, "stores">,
  locationId: string,
  field: string,
): Result<never> | undefined {
  const location = ctx.stores.locations.get(locationId);
  if (!location) return fieldError(field, "保管場所を選んでください");
  if (location.archived) return fieldError(field, "取引終了の保管場所は選べません");
  return undefined;
}

/** 明細の商品がすべて登録されているか */
export function checkItems(
  ctx: Pick<UsecaseContext, "stores">,
  itemIds: readonly string[],
): Result<never> | undefined {
  const found = new Set(ctx.stores.items.getMany(itemIds).map((i) => i.id));
  if (itemIds.some((id) => !found.has(id)))
    return err("validation", "登録されていない商品が含まれています");
  return undefined;
}

/** 業務日が未来でないか（在庫は起きたことを記録するので、先の日付では記録しない） */
export function checkNotFuture(
  ctx: Pick<UsecaseContext, "clock">,
  date: string,
  field: string,
): Result<never> | undefined {
  return date > ctx.clock.today()
    ? fieldError(field, "今日より後の日付は指定できません")
    : undefined;
}

export const createStockOperation = defineCommand({
  permission: "stock.manage",
  input: createInput,
  run(ctx, input) {
    const problem =
      checkNotFuture(ctx, input.operationDate, "operationDate") ??
      checkLocation(ctx, input.locationId, "locationId") ??
      (input.kind === "transfer"
        ? checkLocation(ctx, input.toLocationId, "toLocationId")
        : undefined) ??
      checkItems(
        ctx,
        input.lines.map((l) => l.itemId),
      );
    if (problem) return problem;
    if (input.kind === "store_transfer") {
      const store = ctx.stores.retailStores.get(input.storeId);
      if (!store || store.archived) return fieldError("storeId", "払い出し先店舗を選んでください");
    }

    const movements = stockOperationMovements(
      input.kind === "transfer"
        ? {
            kind: "transfer",
            fromLocationId: input.locationId,
            toLocationId: input.toLocationId,
            lines: input.lines,
          }
        : input.kind === "store_transfer"
          ? { kind: "store_transfer", locationId: input.locationId, lines: input.lines }
          : {
              kind: "adjustment",
              locationId: input.locationId,
              reason: input.reason,
              lines: input.lines,
            },
    );
    if (!movements.ok) return movements;

    const id = ctx.ids.next();
    const number = ctx.sequences.next("stockOperation", input.operationDate);
    const fields: StockOperationFields = {
      number,
      kind: input.kind,
      operationDate: input.operationDate,
      locationId: input.locationId,
      toLocationId: input.kind === "transfer" ? input.toLocationId : null,
      storeId: input.kind === "store_transfer" ? input.storeId : null,
      adjustmentReason: input.kind === "adjustment" ? input.reason : null,
      memo: input.memo,
    };
    ctx.stores.stockOperations.insert(
      id,
      fields,
      input.lines.map((l) => ({ id: ctx.ids.next(), itemId: l.itemId, quantity: l.quantity })),
      { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId },
    );
    const posted = postStock(
      ctx,
      {
        sourceType: "stock_operation",
        sourceId: id,
        businessDate: input.operationDate,
        memo: input.memo,
      },
      movements.value,
    );
    if (!posted.ok) return posted;
    ctx.audit.record({
      entityType: "stock_operation",
      entityId: id,
      action: "create",
      after: { ...fields, lines: input.lines },
    });
    return ok({ id, number });
  },
});

const KINDS = [
  "adjustment",
  "transfer",
  "store_transfer",
  "stocktake",
] as const satisfies readonly StockOperationKind[];

export const listStockOperations = defineQuery({
  permission: "view",
  input: pageInput.extend({
    kind: z.enum(KINDS).optional(),
    locationId: z.string().max(64).optional(),
    from: z.string().max(10).optional(),
    to: z.string().max(10).optional(),
  }),
  run(ctx, { page, pageSize, ...filter }) {
    return ctx.stores.stockOperations.list(filter, page, pageSize);
  },
});

export const getStockOperation = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): StockOperationDetail | null {
    return ctx.stores.stockOperations.get(id) ?? null;
  },
});
