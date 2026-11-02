/**
 * 商品の CSV 一括登録（要件定義書 3.2 Should）。形式は domain/item-import.ts。
 * 1. items.importCheck：すべての行を、商品の登録画面と同じ検証で確かめる（何も書き込まない）。行ごとの問題と、
 *    新規・更新の別、確かめたときの計画（更新する商品の版番号）を返す
 * 2. items.import：もう一度すべての行を確かめ、1行でも問題があれば何もしない。確かめたときの計画と違えば
 *    （ほかの人が登録・更新した）止める。問題がなければ1つのトランザクションで登録・更新し、商品ごとに操作履歴を残す
 * CSV の文字コード（BOM 付き UTF-8・Shift_JIS）の判定と大きさの上限は web 層で扱い、ここには文字列で渡す。
 */
import { z } from "zod";

import { parseCsv } from "../../domain/csv";
import {
  changedPlanEntries,
  duplicateCodeLines,
  importPlanToken,
  itemCsvHeader,
  readItemCsv,
  toItemDraft,
} from "../../domain/item-import";
import { err, ok, type DomainError } from "../../domain/result";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE, type QueryContext } from "../core";
import { checkReferences, createInput, nextFreeItemCode, updateFields } from "./items";
import type { ItemFields, ItemRecord } from "./items.port";

/** 渡せる CSV の大きさ（文字数）。web 層ではファイルを 1 MB までにしている */
const MAX_CSV_CHARS = 1_200_000;

export interface ItemImportRow {
  /** ファイルの中の行番号 */
  readonly line: number;
  readonly action: "create" | "update";
  /** 商品コード（空なら自動で採番する） */
  readonly code: string | null;
  readonly name: string;
  /** 更新する商品と、確かめたときの版番号 */
  readonly itemId: string | null;
  readonly version: number | null;
  /** 「列の名前：内容」の形の問題。空なら取り込める */
  readonly errors: readonly string[];
}

export interface ItemImportCheck {
  /** ファイル全体の問題（見出し・行の数・CSV の形式） */
  readonly fileError: { readonly message: string; readonly details: readonly string[] } | null;
  readonly rows: readonly ItemImportRow[];
  readonly counts: { readonly create: number; readonly update: number; readonly error: number };
  /** 登録するときに渡す、確かめたときの計画 */
  readonly planToken: string;
}

interface PreparedRow extends ItemImportRow {
  readonly before: ItemRecord | undefined;
  readonly fields: ItemFields | null;
}

function fileError(error: DomainError) {
  return { message: error.message, details: error.details ?? [] };
}

/** すべての行を確かめて、行ごとの計画を作る（書き込まない） */
function prepare(
  ctx: Pick<QueryContext, "stores">,
  csv: string,
): { fileError: ItemImportCheck["fileError"]; rows: PreparedRow[] } {
  const parsed = parseCsv(csv);
  if (!parsed.ok) return { fileError: fileError(parsed.error), rows: [] };
  const read = readItemCsv(parsed.value);
  if (!read.ok) return { fileError: fileError(read.error), rows: [] };
  const drafts = read.value.map((row) => {
    const { draft, problems } = toItemDraft(row.values);
    return { row, draft, problems };
  });

  const supplierIds = new Map<string, string[]>();
  for (const s of ctx.stores.partners.options("supplier"))
    supplierIds.set(s.name, [...(supplierIds.get(s.name) ?? []), s.id]);
  const codes = [...new Set(drafts.map((d) => d.draft.code).filter((c) => c !== ""))];
  const existing = new Map(ctx.stores.items.findByCodes(codes).map((i) => [i.code, i]));
  const genreIds = new Map<string, string | null>();
  const genreId = (name: string): string | null => {
    if (!genreIds.has(name)) genreIds.set(name, ctx.stores.genres.findByName(name)?.id ?? null);
    return genreIds.get(name) ?? null;
  };
  const duplicates = duplicateCodeLines(
    drafts.map((d) => ({ line: d.row.line, code: d.draft.code })),
  );

  const rows = drafts.map(({ row, draft, problems }): PreparedRow => {
    const errors = [
      ...row.problems,
      ...problems.map((p) => `${itemCsvHeader(p.key)}：${p.message}`),
    ];
    const before = draft.code === "" ? undefined : existing.get(draft.code);
    const firstLine = duplicates.get(row.line);
    if (firstLine !== undefined)
      errors.push(`${itemCsvHeader("code")}：${firstLine}行目と同じ商品コードです`);

    // 仕入先・ジャンルは名前から決める（更新で今と同じ名前なら、取引終了でもそのまま使える）
    let supplierId = "";
    let supplierProblem = false;
    const supplierName = draft.supplierName.trim();
    if (before && supplierName === before.supplierName) supplierId = before.supplierId;
    else if (supplierName !== "") {
      const ids = supplierIds.get(supplierName) ?? [];
      const [only] = ids;
      if (ids.length === 1 && only) supplierId = only;
      else {
        supplierProblem = true;
        errors.push(
          ids.length > 1
            ? `${itemCsvHeader("supplierId")}：「${supplierName}」という名前の仕入先が複数あります。取引先の名前を変えて区別してください`
            : `${itemCsvHeader("supplierId")}：「${supplierName}」という仕入先が見つかりません（取引終了の仕入先は選べません）`,
        );
      }
    }
    let genre: string | null = null;
    const genreName = draft.genreName.trim();
    if (genreName !== "") {
      if (before && genreName === before.genreName) genre = before.genreId;
      else {
        genre = genreId(genreName);
        if (genre === null)
          errors.push(
            `${itemCsvHeader("genreId")}：「${genreName}」というジャンルが見つかりません`,
          );
      }
    }

    const input = {
      code: draft.code,
      jan: draft.jan,
      name: draft.name,
      supplierId,
      genreId: genre,
      temperatureZone: draft.temperatureZone,
      taxCategory: draft.taxCategory,
      purchaseUnitName: draft.purchaseUnitName,
      salesUnitName: draft.salesUnitName,
      unitsPerPurchaseUnit: draft.unitsPerPurchaseUnit,
      purchasePriceCenti: draft.purchasePriceCenti,
      salesPriceCenti: draft.salesPriceCenti,
      purchaseMinLot: draft.purchaseMinLot,
      salesMinLot: draft.salesMinLot,
      leadTimeDays: draft.leadTimeDays,
      reorderEnabled: draft.reorderEnabled,
      reorderPoint: draft.reorderPoint,
      purchaseShippingNote: draft.purchaseShippingNote,
      salesShippingNote: draft.salesShippingNote,
      inputPriceOnOrder: draft.inputPriceOnOrder,
      memo: draft.memo,
    };
    const checked = before ? updateFields.safeParse(input) : createInput.safeParse(input);
    let fields: ItemFields | null = null;
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key === "supplierId" && supplierProblem) continue;
        errors.push(`${itemCsvHeader(key)}：${issue.message}`);
      }
    } else if (errors.length === 0) {
      const references = checkReferences(ctx, checked.data, before, "");
      if (references && !references.ok)
        for (const f of references.error.fields ?? [])
          errors.push(`${itemCsvHeader(f.field)}：${f.message}`);
      else fields = checked.data;
    }
    const unique = [...new Set(errors)];
    return {
      line: row.line,
      action: before ? "update" : "create",
      code: draft.code === "" ? null : draft.code,
      name: draft.name.trim(),
      itemId: before?.id ?? null,
      version: before?.version ?? null,
      errors: unique,
      before,
      fields: unique.length === 0 ? fields : null,
    };
  });
  return { fileError: null, rows };
}

function publicRow(row: PreparedRow): ItemImportRow {
  return {
    line: row.line,
    action: row.action,
    code: row.code,
    name: row.name,
    itemId: row.itemId,
    version: row.version,
    errors: row.errors,
  };
}

const csvInput = z.string().max(MAX_CSV_CHARS, "CSV が大きすぎます。ファイルを分けてください");

/** 取り込む前の確認（すべての行を確かめる。何も書き込まない） */
export const checkItemImport = defineQuery({
  permission: "items.manage",
  input: z.object({ csv: csvInput }),
  run(ctx, { csv }): ItemImportCheck {
    const { fileError: problem, rows } = prepare(ctx, csv);
    return {
      fileError: problem,
      rows: rows.map(publicRow),
      counts: {
        create: rows.filter((r) => r.errors.length === 0 && r.action === "create").length,
        update: rows.filter((r) => r.errors.length === 0 && r.action === "update").length,
        error: rows.filter((r) => r.errors.length > 0).length,
      },
      planToken: importPlanToken(rows),
    };
  },
});

/** 取込：すべての行に問題がなければ、1つのトランザクションで登録・更新する */
export const importItems = defineCommand({
  permission: "items.manage",
  input: z.object({ csv: csvInput, planToken: z.string().max(200_000) }),
  run(ctx, { csv, planToken }) {
    const { fileError: problem, rows } = prepare(ctx, csv);
    if (problem) return err("validation", problem.message, { details: problem.details });
    const bad = rows.filter((r) => r.errors.length > 0);
    if (bad.length > 0)
      return err("validation", `${bad.length}行に問題があるため、どの商品も登録していません`, {
        details: bad.slice(0, 50).flatMap((r) => r.errors.map((e) => `${r.line}行目：${e}`)),
      });
    const changed = changedPlanEntries(planToken, rows);
    if (changed.length > 0)
      return err(
        "conflict",
        "確かめた後に、ほかの人が同じ商品コードの商品を登録・更新しました。ファイルをもう一度確かめてください",
        {
          details: changed
            .slice(0, 20)
            .map((i) => `${rows[i]?.line ?? ""}行目（${rows[i]?.code ?? "自動で採番"}）`),
        },
      );
    const meta = { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId };
    const reserved = new Set(rows.flatMap((r) => (r.code === null ? [] : [r.code])));
    const created: string[] = [];
    const updated: string[] = [];
    for (const row of rows) {
      const fields = row.fields;
      if (!fields) return err("validation", `${row.line}行目を取り込めません`);
      if (row.before && row.version !== null) {
        if (!ctx.stores.items.update(row.before.id, row.version, fields, meta))
          return err("conflict", STALE_VERSION_MESSAGE);
        ctx.audit.record({
          entityType: "item",
          entityId: row.before.id,
          action: "update",
          before: row.before,
          after: fields,
        });
        updated.push(fields.code);
        continue;
      }
      let code = fields.code;
      if (code === "") {
        const free = nextFreeItemCode(ctx, (c) => reserved.has(c));
        if (!free)
          return err(
            "conflict",
            `${row.line}行目：商品コードを自動で採番できませんでした。コードを入力してください`,
          );
        code = free;
        reserved.add(code);
      }
      const id = ctx.ids.next();
      const values: ItemFields = { ...fields, code };
      ctx.stores.items.insert(id, values, meta);
      ctx.audit.record({ entityType: "item", entityId: id, action: "create", after: values });
      created.push(code);
    }
    const importId = ctx.ids.next();
    ctx.audit.record({
      entityType: "item_import",
      entityId: importId,
      action: "import",
      after: { rows: rows.length, created, updated },
    });
    return ok({ importId, created: created.length, updated: updated.length });
  },
});
