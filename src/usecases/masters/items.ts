/**
 * 商品マスタ（要件定義書 3.2）。商品コードは必須で重複不可、未定なら自動で採番する（IT000001 の形式）。
 * 取引で使われた商品は削除できず「取扱終了」にする。初期在庫は商品の登録と切り離し、在庫調整で入れる。
 */
import { z } from "zod";

import { firstFreeCode, isValidItemCode, TEMPERATURE_ZONES } from "../../domain/items";
import { err, ok, type Result } from "../../domain/result";
import { janError } from "../../domain/validation";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE, type UsecaseContext } from "../core";
import {
  idSchema,
  optionalText,
  pageInput,
  requiredText,
  taxCategory,
  version,
  type Page,
} from "../schemas";
import type { ItemFields, ItemRecord } from "./items.port";

function countInput(label: string, min: number, max: number) {
  return z
    .number({ error: `${label}は数字で入力してください` })
    .int(`${label}は整数で入力してください`)
    .min(min, `${label}は${min}以上で入力してください`)
    .max(max, `${label}は${max.toLocaleString("ja-JP")}以下で入力してください`);
}

function priceInput(label: string) {
  return z
    .number({ error: `${label}は小数第2位までの数字で入力してください（例：1234.56）` })
    .int(`${label}は小数第2位までで入力してください`)
    .min(0, `${label}は0以上で入力してください`)
    .max(99_999_999_999, `${label}が大きすぎます`);
}

const codeInput = z
  .string()
  .trim()
  .refine(
    (v) => v === "" || isValidItemCode(v),
    "商品コードは英数字・ハイフン・下線の30文字以内で入力してください",
  );

const janInput = z
  .string()
  .optional()
  .nullable()
  .transform((value, ctx) => {
    const t = (value ?? "").trim();
    if (t === "") return null;
    const problem = janError(t);
    if (problem === "format") {
      ctx.addIssue({ code: "custom", message: "JAN は8桁または13桁の数字で入力してください" });
      return z.NEVER;
    }
    if (problem === "check_digit") {
      ctx.addIssue({ code: "custom", message: "JAN のチェックディジットが正しくありません" });
      return z.NEVER;
    }
    return t;
  });

const optionalId = z
  .string()
  .max(64)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

const fieldsShape = {
  code: codeInput,
  jan: janInput,
  name: requiredText(100),
  supplierId: z.string().min(1, "仕入先を選んでください").max(64),
  genreId: optionalId,
  temperatureZone: z
    .enum(TEMPERATURE_ZONES, { error: "温度帯を選んでください" })
    .default("ambient"),
  // 画面の選択肢の「選んでください」（空）も受け取り、エラーにする
  taxCategory: z
    .union([taxCategory, z.literal("")], { error: "税区分を選んでください" })
    .transform((v, ctx) => {
      if (v === "") {
        ctx.addIssue({ code: "custom", message: "税区分を選んでください" });
        return z.NEVER;
      }
      return v;
    }),
  purchaseUnitName: requiredText(20),
  salesUnitName: requiredText(20),
  unitsPerPurchaseUnit: countInput("入数", 1, 99_999),
  purchasePriceCenti: priceInput("仕入価格"),
  salesPriceCenti: priceInput("卸単価"),
  purchaseMinLot: countInput("最低ロット", 1, 99_999).default(1),
  salesMinLot: countInput("最低ロット", 1, 99_999).default(1),
  leadTimeDays: countInput("リードタイム", 0, 365).nullable().default(null),
  reorderEnabled: z.boolean().default(false),
  reorderPoint: countInput("発注点在庫数", 0, 9_999_999).default(0),
  purchaseShippingNote: optionalText(200),
  salesShippingNote: optionalText(200),
  inputPriceOnOrder: z.boolean().default(false),
  memo: optionalText(2000),
};

/** 登録では商品コードを空にでき、空なら自動で採番する */
const createInput = z.object({ ...fieldsShape, code: codeInput.default("") });
/** 編集では商品コードは必須 */
const updateFields = z.object({
  ...fieldsShape,
  code: codeInput.refine((v) => v !== "", "商品コードを入力してください"),
});

function fieldError(prefix: string, field: string, message: string): Result<never> {
  return err("validation", message, { fields: [{ field: `${prefix}${field}`, message }] });
}

/**
 * 仕入先と取扱ジャンルの存在を確かめる。取引終了の仕入先・ジャンルは、新しく選ぶことはできない
 * （登録済みの商品がそのまま使い続けるのはよい）。
 */
function checkReferences(
  ctx: UsecaseContext,
  fields: Pick<ItemFields, "supplierId" | "genreId">,
  before: ItemRecord | undefined,
  prefix: string,
): Result<never> | undefined {
  const supplier = ctx.stores.partners.get(fields.supplierId);
  if (!supplier || !supplier.isSupplier)
    return fieldError(prefix, "supplierId", "仕入先を選んでください");
  if (supplier.archived && before?.supplierId !== fields.supplierId)
    return fieldError(prefix, "supplierId", "取引終了の仕入先は選べません");
  if (fields.genreId !== null) {
    const genre = ctx.stores.genres.get(fields.genreId);
    if (!genre) return fieldError(prefix, "genreId", "ジャンルが見つかりません");
    if (genre.archived && before?.genreId !== fields.genreId)
      return fieldError(prefix, "genreId", "取引終了のジャンルは選べません");
  }
  return undefined;
}

function duplicateCode(prefix: string): Result<never> {
  return err("duplicate", "この商品コードはすでに使われています", {
    fields: [{ field: `${prefix}code`, message: "すでに使われています" }],
  });
}

export const createItem = defineCommand({
  permission: "items.manage",
  input: createInput,
  run(ctx, input) {
    const problem = checkReferences(ctx, input, undefined, "");
    if (problem) return problem;
    let code = input.code;
    if (code === "") {
      const today = ctx.clock.today();
      function* candidates() {
        for (;;) yield ctx.sequences.next("item", today);
      }
      const free = firstFreeCode(candidates(), (c) => ctx.stores.items.findByCode(c) !== undefined);
      if (!free)
        return err("conflict", "商品コードを自動で採番できませんでした。コードを入力してください");
      code = free;
    } else if (ctx.stores.items.findByCode(code)) {
      return duplicateCode("");
    }
    const id = ctx.ids.next();
    const fields: ItemFields = { ...input, code };
    ctx.stores.items.insert(id, fields, {
      at: ctx.clock.now().toISOString(),
      by: ctx.actor.employeeId,
    });
    ctx.audit.record({ entityType: "item", entityId: id, action: "create", after: fields });
    return ok({ id, code });
  },
});

export const updateItem = defineCommand({
  permission: "items.manage",
  input: z.object({ id: idSchema, version, fields: updateFields }),
  run(ctx, { id, version: v, fields }) {
    const before = ctx.stores.items.get(id);
    if (!before) return err("not_found", "商品が見つかりません");
    const problem = checkReferences(ctx, fields, before, "fields.");
    if (problem) return problem;
    const same = ctx.stores.items.findByCode(fields.code);
    if (same && same.id !== id) return duplicateCode("fields.");
    const updated = ctx.stores.items.update(id, v, fields, {
      at: ctx.clock.now().toISOString(),
      by: ctx.actor.employeeId,
    });
    if (!updated) return err("conflict", STALE_VERSION_MESSAGE);
    ctx.audit.record({ entityType: "item", entityId: id, action: "update", before, after: fields });
    return ok({ id });
  },
});

/** 取扱終了にする（または取り消す）。取扱終了の商品は発注・受注の商品選択に出なくなる */
export const discontinueItem = defineCommand({
  permission: "items.manage",
  input: z.object({ id: idSchema, version, discontinued: z.boolean() }),
  run(ctx, { id, version: v, discontinued }) {
    if (!ctx.stores.items.get(id)) return err("not_found", "商品が見つかりません");
    const updated = ctx.stores.items.update(
      id,
      v,
      { discontinued },
      { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId },
    );
    if (!updated) return err("conflict", STALE_VERSION_MESSAGE);
    ctx.audit.record({
      entityType: "item",
      entityId: id,
      action: discontinued ? "discontinue" : "resume",
    });
    return ok({ id });
  },
});

/** 取引で使われていない商品だけを削除できる（登録の誤りを消すため） */
export const deleteItem = defineCommand({
  permission: "items.manage",
  input: z.object({ id: idSchema }),
  run(ctx, { id }) {
    const before = ctx.stores.items.get(id);
    if (!before) return err("not_found", "商品が見つかりません");
    if (ctx.stores.items.isUsed(id)) {
      return err(
        "invalid_state",
        "取引や在庫で使われた商品は削除できません。「取扱終了」にしてください",
      );
    }
    ctx.stores.items.delete(id);
    ctx.audit.record({ entityType: "item", entityId: id, action: "delete", before });
    return ok({ id });
  },
});

const filterInput = {
  q: z.string().max(100).optional(),
  supplierId: z.string().max(64).optional(),
  genreId: z.string().max(64).optional(),
};

export const listItems = defineQuery({
  permission: "view",
  input: pageInput.extend({ ...filterInput, includeDiscontinued: z.boolean().default(false) }),
  run(ctx, { page, pageSize, ...filter }): Page<ItemRecord> {
    return ctx.stores.items.list(filter, page, pageSize);
  },
});

export const getItem = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): ItemRecord | null {
    return ctx.stores.items.get(id) ?? null;
  },
});

/**
 * 指定した ID の商品をまとめて返す（見つからない ID は除く、並びは ids の順）。
 * 商品選択ダイアログで選んだ商品を、発注・受注・在庫操作の明細の行にするときに使う。
 */
export const getItems = defineQuery({
  permission: "view",
  input: z.object({ ids: z.array(idSchema).max(500) }),
  run(ctx, { ids }): ItemRecord[] {
    return ctx.stores.items.getMany(ids);
  },
});

/**
 * 商品選択ダイアログの検索。選択済みの商品（selectedIds）は先頭にまとめて返し、
 * 検索結果からは除く（検索し直しても選択が消えないように）。取扱終了の商品は既定で除く。
 */
export const pickItems = defineQuery({
  permission: "view",
  input: z.object({
    ...filterInput,
    selectedIds: z.array(idSchema).max(200).default([]),
    includeDiscontinued: z.boolean().default(false),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(30),
  }),
  run(ctx, { selectedIds, page, pageSize, ...filter }) {
    const selected = ctx.stores.items.getMany(selectedIds);
    const results = ctx.stores.items.list(
      { ...filter, excludeIds: selected.map((s) => s.id) },
      page,
      pageSize,
    );
    return { selected, results };
  },
});
