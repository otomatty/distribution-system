import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { csvField, csvResponse, encodeCsv } from "./csv";
import type { AppEnv } from "./types";

describe("CSV", () => {
  it("区切り・引用符・改行を含む値は引用符で囲み、引用符は2つ重ねる（RFC 4180）", () => {
    expect(csvField("りんご")).toBe("りんご");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('5" ゼリー')).toBe('"5"" ゼリー"');
    expect(csvField("1行目\n2行目")).toBe('"1行目\n2行目"');
    expect(csvField("a\r\nb")).toBe('"a\r\nb"');
    expect(csvField(null)).toBe("");
    expect(csvField(1234)).toBe("1234");
    expect(csvField(-50)).toBe("-50");
    expect(csvField(Number.NaN)).toBe("");
  });

  it("数式として実行されないよう、= + - @ で始まる文字列の先頭に ' を付ける", () => {
    expect(csvField("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(csvField("+81")).toBe("'+81");
    expect(csvField("-1")).toBe("'-1");
    expect(csvField("@cmd")).toBe("'@cmd");
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it("BOM 付きで、行の区切りは CRLF", () => {
    const text = encodeCsv(
      ["番号", "金額"],
      [
        ["A-1", 100],
        ["B,2", null],
      ],
    );
    expect(text).toBe('\uFEFF番号,金額\r\nA-1,100\r\n"B,2",\r\n');
  });

  it("ダウンロードの応答（日本語のファイル名は RFC 5987）", async () => {
    const app = new Hono<AppEnv>();
    app.get("/", (c) => csvResponse(c, "帳票一覧_2026-11-02.csv", ["番号"], [["A-1"]]));
    const res = await app.request("/");
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="_____2026-11-02.csv"; filename*=UTF-8''${encodeURIComponent("帳票一覧_2026-11-02.csv")}`,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });
});
