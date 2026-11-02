/**
 * 棚卸（要件定義書 3.4 の Should）：保管場所ごとに実際の数を一括で入力し、帳簿在庫との差を「棚卸差異」として記録する。
 * 入力中に在庫が動いた商品があれば、差を取り違えないように登録を止めて、帳簿在庫を最新にしてもらう。
 */
import { z } from "zod";

import { err, ok } from "../../domain/result";
import { stockOperationMovements } from "../../domain/stock";
import { defineCommand, defineQuery } from "../core";
import { businessDate, idSchema, optionalText } from "../schemas";
import { postStock } from "./ledger";
import { checkItems, checkLocation, checkNotFuture } from "./operations";
import type { StockOperationFields } from "./operations.port";

const countInput = z
  .number({ error: "実際の数は数字で入力してください" })
  .int("実際の数は整数で入力してください")
  .min(0, "実際の数は0以上で入力してください")
  .max(9_999_999, "実際の数が大きすぎます");

/** 入力中に在庫が動いたときのメッセージ（details に商品の ID が入る） */
export const STOCKTAKE_CHANGED_MESSAGE =
  "入力中に在庫が動いた商品があります。帳簿在庫を最新にしたので、差を確かめてから登録し直してください";

export const createStocktake = defineCommand({
  permission: "stock.manage",
  input: z.object({
    operationDate: businessDate,
    locationId: idSchema,
    memo: optionalText(500),
    lines: z
      .array(
        z.object({
          itemId: idSchema,
          /** 実際に数えた数 */
          counted: countInput,
          /** 入力画面を開いたときの帳簿在庫（入力中に在庫が動いていないかの確認に使う） */
          expected: z.number().int(),
        }),
      )
      .min(1, "実際の数を1つ以上入力してください")
      .max(3000, "1回の棚卸で入力できる商品は3000件までです"),
  }),
  run(ctx, input) {
    const problem =
      checkNotFuture(ctx, input.operationDate, "operationDate") ??
      checkLocation(ctx, input.locationId, "locationId") ??
      checkItems(
        ctx,
        input.lines.map((l) => l.itemId),
      );
    if (problem) return problem;
    const onHand = (itemId: string) => ctx.stores.stock.balance(itemId, input.locationId).onHand;
    const changed = input.lines.filter((l) => onHand(l.itemId) !== l.expected);
    if (changed.length > 0)
      return err("conflict", STOCKTAKE_CHANGED_MESSAGE, { details: changed.map((l) => l.itemId) });

    const movements = stockOperationMovements({
      kind: "stocktake",
      locationId: input.locationId,
      lines: input.lines.map((l) => ({ itemId: l.itemId, quantity: l.counted })),
      currentOnHand: onHand,
    });
    if (!movements.ok) return movements;

    const id = ctx.ids.next();
    const fields: StockOperationFields = {
      number: ctx.sequences.next("stockOperation", input.operationDate),
      kind: "stocktake",
      operationDate: input.operationDate,
      locationId: input.locationId,
      toLocationId: null,
      storeId: null,
      adjustmentReason: null,
      memo: input.memo,
    };
    ctx.stores.stockOperations.insert(
      id,
      fields,
      input.lines.map((l) => ({ id: ctx.ids.next(), itemId: l.itemId, quantity: l.counted })),
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
      action: "stocktake",
      after: { ...fields, lines: input.lines, differences: movements.value },
    });
    return ok({ id, number: fields.number, differences: movements.value.length });
  },
});

/**
 * 棚卸の入力表：その保管場所に在庫の記録がある商品と、帳簿在庫（商品コードの順）。
 * 取扱終了で在庫が 0 の商品は除く。表にない商品は商品選択ダイアログで追加する。
 */
export const stocktakeSheet = defineQuery({
  permission: "view",
  input: z.object({ locationId: idSchema }),
  run(ctx, { locationId }) {
    const balances = ctx.stores.stock.balancesAt(locationId);
    const onHand = new Map(balances.map((b) => [b.itemId, b.onHand]));
    return ctx.stores.items
      .getMany(balances.map((b) => b.itemId))
      .map((item) => ({ item, onHand: onHand.get(item.id) ?? 0 }))
      .filter((r) => !(r.item.discontinued && r.onHand === 0))
      .toSorted((a, b) => (a.item.code < b.item.code ? -1 : a.item.code > b.item.code ? 1 : 0));
  },
});
