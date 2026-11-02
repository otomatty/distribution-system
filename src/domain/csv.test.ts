import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { unwrap, unwrapErr } from "../../tests/support/result";
import { parseCsv, unescapeCsvValue } from "./csv";

/** テスト用の書き出し（すべての値を引用符で囲む） */
function quoteAll(rows: readonly (readonly string[])[], newline: string): string {
  return rows.map((r) => r.map((v) => `"${v.replaceAll('"', '""')}"`).join(",")).join(newline);
}

/** テスト用の書き出し（必要なときだけ引用符で囲む。RFC 4180） */
function quoteNeeded(rows: readonly (readonly string[])[]): string {
  return rows
    .map((r) => r.map((v) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)).join(","))
    .join("\r\n");
}

const value = fc.string({
  maxLength: 12,
  unit: fc.constantFrom("a", "あ", ",", '"', "\r", "\n", " ", "'", "="),
});

describe("parseCsv", () => {
  it("値・引用符・改行を含む値を読み、行番号を返す", () => {
    const bom = String.fromCodePoint(0xfeff);
    const text = `${bom}商品コード,商品名\r\nA-1,"せんべい, 大"\r\n\r\nA-2,"2行の\n名前"\nA-3,"引用符""あり"""\n`;
    expect(unwrap(parseCsv(text))).toEqual([
      { line: 1, fields: ["商品コード", "商品名"] },
      { line: 2, fields: ["A-1", "せんべい, 大"] },
      { line: 4, fields: ["A-2", "2行の\n名前"] },
      { line: 6, fields: ["A-3", '引用符"あり"'] },
    ]);
  });

  it("空の値・最後の改行なし・CR だけの改行", () => {
    expect(unwrap(parseCsv("a,,c\rd,e,"))).toEqual([
      { line: 1, fields: ["a", "", "c"] },
      { line: 2, fields: ["d", "e", ""] },
    ]);
    expect(unwrap(parseCsv(""))).toEqual([]);
    expect(unwrap(parseCsv('""'))).toEqual([{ line: 1, fields: [""] }]);
  });

  it("閉じていない引用符と、引用符の後の文字はエラー（行番号つき）", () => {
    expect(unwrapErr(parseCsv('a,b\nc,"de\nf')).message).toBe('2行目：引用符（"）が閉じていません');
    expect(unwrapErr(parseCsv('a,"b"c\n')).message).toContain("1行目");
  });

  it("書き出した CSV を読むと元の値に戻る（すべて引用符で囲んだ場合）", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(value, { minLength: 1, maxLength: 5 }), { maxLength: 8 }),
        fc.constantFrom("\r\n", "\n"),
        (rows, newline) => {
          const parsed = unwrap(parseCsv(quoteAll(rows, newline)));
          expect(parsed.map((r) => r.fields)).toEqual(rows);
        },
      ),
    );
  });

  it("書き出した CSV を読むと元の値に戻る（必要なときだけ引用符で囲んだ場合。空の行は飛ばす）", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .array(value, { minLength: 1, maxLength: 5 })
            .filter((r) => !(r.length === 1 && r[0] === "")),
          { maxLength: 8 },
        ),
        (rows) => {
          const parsed = unwrap(parseCsv(quoteNeeded(rows)));
          expect(parsed.map((r) => r.fields)).toEqual(rows);
        },
      ),
    );
  });
});

describe("unescapeCsvValue", () => {
  it("数式の実行を防ぐために付けた先頭の ' だけを外す", () => {
    expect(unescapeCsvValue("'=1+1")).toBe("=1+1");
    expect(unescapeCsvValue("'-注意")).toBe("-注意");
    expect(unescapeCsvValue("'あ")).toBe("'あ");
    expect(unescapeCsvValue("=1")).toBe("=1");
  });
});
