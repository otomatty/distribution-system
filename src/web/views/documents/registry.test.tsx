import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { unwrap, unwrapErr } from "../../../../tests/support/result";
import { PRINT_CSS } from "./layout";
import { Addressee, DocumentDate, DocumentMeta, DocumentTitle, Issuer } from "./parts";
import { defineTemplate, documentTemplates, renderDocumentsHtml } from "./registry";

/** 例：発行するユースケースの側で定義するスナップショットのスキーマ */
const sampleSnapshot = z.object({
  to: z.object({ name: z.string(), honorific: z.string(), address: z.string().nullable() }),
  from: z.object({ name: z.string(), registrationNumber: z.string().nullable() }),
  lines: z.array(z.object({ name: z.string(), quantity: z.number(), amount: z.number() })),
  total: z.number(),
});

const sampleTemplate = defineTemplate({
  schema: sampleSnapshot,
  render: (data, meta) => (
    <>
      <DocumentTitle title="納品書" />
      <DocumentMeta
        items={[
          ["番号", meta.number],
          ["納品日", <DocumentDate date={meta.transactionDate} />],
        ]}
      />
      <div class="doc-head">
        <Addressee to={data.to} />
        <Issuer from={{ ...data.from, phone: "0192-00-0000" }} />
      </div>
      <table class="doc-table">
        <tbody>
          {data.lines.map((l) => (
            <tr>
              <td>{l.name}</td>
              <td class="num">{l.quantity}</td>
              <td class="num">{l.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="doc-total">合計 {data.total}</p>
    </>
  ),
});

const snapshot = {
  to: { name: "大船渡ストア", honorific: "御中", address: "岩手県大船渡市" },
  from: { name: "テスト商事", registrationNumber: "T1234567890123" },
  lines: [{ name: "かもめの玉子 <10個入>", quantity: 3, amount: 3240 }],
  total: 3240,
};
const meta = {
  documentType: "delivery_note",
  number: "DN-2026-000001",
  transactionDate: "2026-11-02",
} as const;

afterEach(() => {
  delete documentTemplates.delivery_note;
  delete documentTemplates.invoice;
});

describe("帳票のテンプレート", () => {
  it("印刷用の CSS は JSX でエスケープされる文字を使わない（<style> にそのまま入る）", () => {
    expect(PRINT_CSS).not.toMatch(/[<>&"']/);
  });

  it("A4 の印刷用 HTML を作る（スナップショット）", async () => {
    documentTemplates.delivery_note = sampleTemplate;
    const result = unwrap(await renderDocumentsHtml([{ meta, snapshot }]));
    expect(result.orientation).toBe("portrait");
    const html = result.html;
    expect(html.startsWith('<!DOCTYPE html><html lang="ja">')).toBe(true);
    expect(html).toContain(`<style>${PRINT_CSS}</style>`);
    expect(html).toContain("<title>納品書 DN-2026-000001</title>");
    // 値はエスケープされる
    expect(html).toContain("かもめの玉子 &lt;10個入&gt;");
    // 外部のファイルを読まない
    expect(html).not.toMatch(/<(link|script|img)\b/);
    expect(html.replace(PRINT_CSS, "")).toMatchSnapshot();
  });

  it("複数の帳票を1つの HTML にまとめ、向きの違う用紙を混ぜられる", async () => {
    documentTemplates.delivery_note = sampleTemplate;
    documentTemplates.invoice = defineTemplate({
      schema: z.object({ title: z.string() }),
      orientation: "landscape",
      title: (data) => data.title,
      render: (data) => <h1>{data.title}</h1>,
    });
    const result = unwrap(
      await renderDocumentsHtml(
        [
          {
            meta: { ...meta, documentType: "invoice", number: "INV-1" },
            snapshot: { title: "横の帳票" },
          },
          { meta, snapshot },
        ],
        "まとめ",
      ),
    );
    expect(result.orientation).toBe("landscape");
    expect(result.html).toContain("<title>まとめ</title>");
    expect(result.html).toContain('<section class="sheet landscape"><h1>横の帳票</h1>');
    expect(result.html).toContain('<section class="sheet"><h1 class="doc-title">納品書</h1>');
  });

  it("テンプレートがない・内容がスキーマに合わない帳票は、理由を返す", async () => {
    const missing = unwrapErr(await renderDocumentsHtml([{ meta, snapshot }]));
    expect(missing.message).toContain("納品書のテンプレートが登録されていない");

    documentTemplates.delivery_note = sampleTemplate;
    const invalid = unwrapErr(
      await renderDocumentsHtml([{ meta, snapshot: { ...snapshot, total: "x" } }]),
    );
    expect(invalid.message).toBe(
      "納品書（DN-2026-000001）：帳票の内容がテンプレートの形式と合いません",
    );
    expect(invalid.details?.[0]).toMatch(/^total: /);
    const notObject = unwrapErr(await renderDocumentsHtml([{ meta, snapshot: null }]));
    expect(notObject.details?.[0]).toMatch(/^\(全体\): /);

    expect(unwrapErr(await renderDocumentsHtml([])).code).toBe("validation");
  });
});
