import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { unwrap, unwrapErr } from "../../tests/support/result";
import type { CsvRecord } from "./csv";
import {
  changedPlanEntries,
  duplicateCodeLines,
  importPlanToken,
  ITEM_CSV_COLUMNS,
  ITEM_CSV_HEADERS,
  itemCsvHeader,
  readItemCsv,
  toItemDraft,
  type ItemCsvKey,
} from "./item-import";

function records(header: readonly string[], ...rows: (readonly string[])[]): CsvRecord[] {
  return [header, ...rows].map((fields, i) => ({ line: i + 1, fields }));
}

function values(v: Partial<Record<ItemCsvKey, string>>): Map<ItemCsvKey, string> {
  return new Map(
    Object.entries(v).flatMap(([k, x]) => {
      const col = ITEM_CSV_COLUMNS.find((c) => c.key === k);
      return col && x !== undefined ? [[col.key, x] as const] : [];
    }),
  );
}

describe("readItemCsv", () => {
  it("見出しで列を決める（順は自由、全角と半角の違いと空白は無視）。値の前後の空白と数式よけの ' を外す", () => {
    const header = [...ITEM_CSV_HEADERS].toReversed().map((h) => ` ${h.replace("（", "(")} `);
    const row = ITEM_CSV_HEADERS.map(() => "").toReversed();
    row[header.length - 1 - ITEM_CSV_HEADERS.indexOf("商品名")] = "  せんべい ";
    row[header.length - 1 - ITEM_CSV_HEADERS.indexOf("備考")] = "'=注意";
    const [first] = unwrap(readItemCsv(records(header, row)));
    expect(first?.line).toBe(2);
    expect(first?.values.get("name")).toBe("せんべい");
    expect(first?.values.get("memo")).toBe("=注意");
    expect(first?.problems).toEqual([]);
  });

  it("列が足りない行は空、見出しより多い列に値があれば行の問題にする", () => {
    const [short, long] = unwrap(
      readItemCsv(records(ITEM_CSV_HEADERS, ["A-1"], [...ITEM_CSV_HEADERS.map(() => ""), "余分"])),
    );
    expect(short?.values.get("code")).toBe("A-1");
    expect(short?.values.get("memo")).toBeUndefined();
    expect(long?.problems).toEqual(["見出しより多くの列に値があります"]);
  });

  it("見出しの問題・行がない・行が多すぎるとファイル全体のエラー", () => {
    expect(unwrapErr(readItemCsv([])).message).toContain("見出しの行がありません");
    const e = unwrapErr(readItemCsv(records(["商品名", "商品名", "色", ""], ["a"])));
    expect(e.details).toContain("「色」は商品の項目にない列です");
    expect(e.details).toContain("「商品名」の列が2つあります");
    expect(e.details).toContain("「商品コード」の列がありません");
    expect(e.details?.some((d) => d.includes("「」"))).toBe(false);
    expect(unwrapErr(readItemCsv(records(ITEM_CSV_HEADERS))).message).toBe(
      "取り込む行がありません",
    );
    const many = records(ITEM_CSV_HEADERS, ["a"], ["b"], ["c"]);
    expect(unwrapErr(readItemCsv(many, 2)).message).toContain("2行までです（3行あります）");
  });
});

describe("toItemDraft", () => {
  it("言葉の列を内部の値にし、数・金額は全角・カンマ・円記号を読み、空は初期値に任せる", () => {
    const { draft, problems } = toItemDraft(
      values({
        code: "ＡＢ－１",
        temperatureZone: "冷凍",
        taxCategory: "8%",
        unitsPerPurchaseUnit: "２４",
        purchasePriceCenti: "¥1,234.5",
        salesPriceCenti: "98円",
        inputPriceOnOrder: "はい",
        reorderEnabled: "○",
        leadTimeDays: "",
        purchaseMinLot: "",
      }),
    );
    expect(problems).toEqual([]);
    expect(draft).toMatchObject({
      code: "AB-1",
      temperatureZone: "frozen",
      taxCategory: "reduced",
      unitsPerPurchaseUnit: 24,
      purchasePriceCenti: 123_450,
      salesPriceCenti: 9_800,
      inputPriceOnOrder: true,
      reorderEnabled: true,
      leadTimeDays: null,
      purchaseMinLot: undefined,
    });
    const empty = toItemDraft(values({})).draft;
    expect(empty).toMatchObject({
      temperatureZone: "ambient",
      taxCategory: "",
      inputPriceOnOrder: false,
      reorderEnabled: false,
      unitsPerPurchaseUnit: undefined,
    });
    expect(
      toItemDraft(values({ taxCategory: "標準税率", temperatureZone: "chilled" })).draft,
    ).toMatchObject({
      taxCategory: "standard",
      temperatureZone: "chilled",
    });
  });

  it("読めない言葉は列ごとの問題、読めない数は NaN（登録画面と同じ検証でエラーになる）", () => {
    const { draft, problems } = toItemDraft(
      values({
        temperatureZone: "ぬるい",
        taxCategory: "5%",
        reorderEnabled: "たぶん",
        unitsPerPurchaseUnit: "1.5",
        salesPriceCenti: "1.234",
      }),
    );
    expect(problems.map((p) => p.key)).toEqual([
      "temperatureZone",
      "taxCategory",
      "reorderEnabled",
    ]);
    expect(draft.unitsPerPurchaseUnit).toBeNaN();
    expect(draft.salesPriceCenti).toBeNaN();
  });

  it("小数第2位までの金額は centi-yen の整数に正しく直る", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99_999_999_999 }), (centi) => {
        const text = `${Math.floor(centi / 100).toLocaleString("en-US")}.${String(centi % 100).padStart(2, "0")}`;
        expect(toItemDraft(values({ salesPriceCenti: text })).draft.salesPriceCenti).toBe(centi);
      }),
    );
  });
});

describe("商品コードの重なりと取込の計画", () => {
  it("同じ商品コードは2回目以降の行を、最初の行の番号とともに返す（空のコードは比べない）", () => {
    const map = duplicateCodeLines([
      { line: 2, code: "A" },
      { line: 3, code: "" },
      { line: 4, code: "A" },
      { line: 5, code: "" },
      { line: 6, code: "A" },
    ]);
    expect([...map.entries()]).toEqual([
      [4, 2],
      [6, 2],
    ]);
  });

  it("計画が同じなら違いはなく、版番号・新規と更新・行の数が変われば違いを返す", () => {
    const created = { itemId: null, version: null };
    const updated = { itemId: "01A", version: 3 };
    const plan = [created, updated];
    const token = importPlanToken(plan);
    expect(token).toBe("+,01A@3");
    expect(changedPlanEntries(token, plan)).toEqual([]);
    expect(changedPlanEntries(token, [created, { itemId: "01A", version: 4 }])).toEqual([1]);
    expect(changedPlanEntries(token, [{ itemId: "01B", version: 1 }, updated])).toEqual([0]);
    expect(changedPlanEntries(token, [created])).toEqual([0]);
    expect(changedPlanEntries("", [])).toEqual([]);
    expect(importPlanToken([])).toBe("");
  });

  it("見出しの名前は項目名から引ける", () => {
    expect(itemCsvHeader("supplierId")).toBe("仕入先");
    expect(itemCsvHeader("unknown")).toBe("unknown");
  });
});
