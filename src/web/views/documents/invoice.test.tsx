import { describe, expect, it } from "vitest";

import { unwrap, unwrapErr } from "../../../../tests/support/result";
import type { CreditNoteSnapshot, InvoiceSnapshot } from "../../../usecases/billing/snapshots";
import { PRINT_CSS } from "./layout";
import { renderDocumentsHtml } from "./registry";

const issuer = {
  name: "架空菓子流通株式会社",
  registrationNumber: "T1234567890123",
  postalCode: "0220002",
  address: "岩手県大船渡市大船渡町9-9-9",
  phone: "0192-00-0000",
  fax: null,
  email: "billing@example.co.jp",
  bankInfo: "テスト銀行 本店 普通 0000000 カクウカシリュウツウ（カ",
};

const recipient = {
  name: "サンプル商店 <本店>",
  honorific: "御中",
  postalCode: "0220003",
  address: "岩手県大船渡市盛町0-0",
};

const invoice: InvoiceSnapshot = {
  version: 1,
  number: "INV-2026-000123",
  issuedOn: "2026-10-31",
  periodFrom: "2026-10-01",
  periodTo: "2026-10-31",
  dueOn: "2026-11-30",
  issuer,
  recipient,
  deliveries: [
    {
      shippedOn: "2026-10-05",
      deliveryNoteNumber: "DN-2026-000010",
      salesOrderNumber: "SO-2026-000020",
      lines: [
        {
          itemCode: "IT000001",
          name: "テスト銘菓 うみねこサブレ 10枚入",
          quantity: 3,
          unitName: "箱",
          unitPriceCenti: 15_050,
          amount: 451,
          taxCategory: "reduced",
          reduced: true,
        },
        {
          itemCode: "IT000002",
          name: "紙袋（大）",
          quantity: 6,
          unitName: "枚",
          unitPriceCenti: 10_000,
          amount: 600,
          taxCategory: "standard",
          reduced: false,
        },
        {
          itemCode: null,
          name: "送料",
          quantity: 1,
          unitName: null,
          unitPriceCenti: 80_000,
          amount: 800,
          taxCategory: "standard",
          reduced: false,
        },
      ],
    },
  ],
  returns: [
    {
      returnedOn: "2026-10-10",
      number: "RT-2026-000001",
      salesOrderNumber: "SO-2026-000020",
      lines: [
        {
          itemCode: "IT000001",
          name: "返品 テスト銘菓 うみねこサブレ 10枚入",
          quantity: -1,
          unitName: "箱",
          unitPriceCenti: 15_050,
          amount: -150,
          taxCategory: "reduced",
          reduced: true,
        },
      ],
    },
  ],
  taxGroups: [
    { category: "standard", rateBps: 1000, subtotal: 1400, tax: 140 },
    { category: "reduced", rateBps: 800, subtotal: 301, tax: 24 },
  ],
  subtotal: 1701,
  tax: 164,
  total: 1865,
  roundingMode: "floor",
  reissuedFromNumber: null,
  memo: null,
};

const invoiceMeta = {
  documentType: "invoice",
  number: invoice.number,
  transactionDate: invoice.issuedOn,
} as const;

const creditNote: CreditNoteSnapshot = {
  version: 1,
  number: "CN-2026-000007",
  issuedOn: "2026-11-02",
  returnNumber: "RT-2026-000001",
  returnedOn: "2026-10-10",
  originalTransactionDate: "2026-10-05",
  salesOrderNumber: "SO-2026-000020",
  deliveryNoteNumber: "DN-2026-000010",
  invoiceNumber: "INV-2026-000123",
  issuer,
  recipient,
  lines: [
    {
      itemCode: "IT000001",
      name: "テスト銘菓 うみねこサブレ 10枚入",
      quantity: 1,
      unitName: "箱",
      unitPriceCenti: 15_050,
      amount: 150,
      taxCategory: "reduced",
      reduced: true,
    },
  ],
  taxGroups: [{ category: "reduced", rateBps: 800, subtotal: 150, tax: 12 }],
  subtotal: 150,
  tax: 12,
  total: 162,
  roundingMode: "floor",
};

const creditMeta = {
  documentType: "credit_note",
  number: creditNote.number,
  transactionDate: creditNote.issuedOn,
} as const;

describe("請求書のテンプレート", () => {
  it("A4 縦の HTML を作る（スナップショット）", async () => {
    const result = unwrap(await renderDocumentsHtml([{ meta: invoiceMeta, snapshot: invoice }]));
    expect(result.orientation).toBe("portrait");
    expect(result.html).toContain("<title>請求書 INV-2026-000123</title>");
    expect(result.html.replace(PRINT_CSS, "")).toMatchSnapshot();
  });

  it("インボイスの記載事項を載せる（発行者と登録番号・取引年月日・取引内容と軽減税率の対象・税率ごとの合計と税率・税率ごとの消費税額・宛名）", async () => {
    const html = unwrap(await renderDocumentsHtml([{ meta: invoiceMeta, snapshot: invoice }])).html;
    expect(html).toContain("架空菓子流通株式会社");
    expect(html).toContain("登録番号：T1234567890123");
    // 取引年月日（発送日・返品日）
    expect(html).toContain("2026年10月5日");
    expect(html).toContain("2026年10月10日");
    expect(html).toContain("DN-2026-000010");
    expect(html).toContain("返品 RT-2026-000001");
    // 取引内容と、軽減税率の対象である旨
    expect(html).toContain("テスト銘菓 うみねこサブレ 10枚入 ※");
    expect(html).toContain("※は軽減税率（8%）の対象です");
    // 税率ごとの合計額と適用税率、税率ごとの消費税額
    expect(html).toContain("標準税率（10%）対象");
    expect(html).toContain("軽減税率（8%）対象");
    expect(html).toContain("消費税 ¥140");
    expect(html).toContain("消費税 ¥24");
    expect(html).toMatch(
      /<td class="num">10%<\/td><td class="num">¥1,400<\/td><td class="num">¥140<\/td>/,
    );
    // 宛名（値はエスケープする）
    expect(html).toContain("サンプル商店 &lt;本店&gt; 御中");
    expect(html).toContain("ご請求金額（税込） ¥1,865");
    expect(html).toContain("¥-150");
    expect(html).toContain("お支払期限");
    expect(html).toContain("2026年11月30日");
    expect(html).toContain("お振込先：テスト銀行");
    expect(html).not.toContain("再発行");
  });

  it("発送ごとの請求書（締め期間・支払期限なし）と、再発行の注記。スキーマに合わない内容は PDF にしない", async () => {
    const perShipment: InvoiceSnapshot = {
      ...invoice,
      periodFrom: null,
      periodTo: null,
      dueOn: null,
      returns: [],
      issuer: { ...issuer, bankInfo: null },
      reissuedFromNumber: "INV-2026-000100",
      memo: "次回からメールで送付します",
    };
    const html = unwrap(
      await renderDocumentsHtml([{ meta: invoiceMeta, snapshot: perShipment }]),
    ).html;
    expect(html).not.toContain("締め期間");
    expect(html).not.toContain("お支払期限");
    expect(html).not.toContain("お振込先");
    expect(html).not.toContain("マイナスで記載");
    expect(html).toContain("請求書 INV-2026-000100 を取り消して再発行したものです");
    expect(html).toContain("次回からメールで送付します");
    const invalid = unwrapErr(
      await renderDocumentsHtml([{ meta: invoiceMeta, snapshot: { ...invoice, total: "x" } }]),
    );
    expect(invalid.message).toContain("帳票の内容がテンプレートの形式と合いません");
  });
});

describe("返還請求書のテンプレート", () => {
  it("A4 縦の HTML を作る（スナップショット）", async () => {
    const result = unwrap(await renderDocumentsHtml([{ meta: creditMeta, snapshot: creditNote }]));
    expect(result.html).toContain("<title>返還請求書 CN-2026-000007</title>");
    expect(result.html.replace(PRINT_CSS, "")).toMatchSnapshot();
  });

  it("適格返還請求書の記載事項を載せる（発行者と登録番号・返品日と元の取引年月日・内容と軽減税率の対象・税率ごとの返還額と税率・消費税額）", async () => {
    const html = unwrap(
      await renderDocumentsHtml([{ meta: creditMeta, snapshot: creditNote }]),
    ).html;
    expect(html).toContain("登録番号：T1234567890123");
    expect(html).toContain("返品日");
    expect(html).toContain("2026年10月10日");
    expect(html).toContain("元の取引年月日");
    expect(html).toContain("2026年10月5日");
    expect(html).toContain("テスト銘菓 うみねこサブレ 10枚入 ※");
    expect(html).toContain("※は軽減税率（8%）の対象です");
    expect(html).toContain("軽減税率（8%）対象");
    expect(html).toContain("消費税 ¥12");
    expect(html).toContain("返還額（税込） ¥162");
    expect(html).toContain("INV-2026-000123");
    expect(html).toContain("サンプル商店 &lt;本店&gt; 御中");
    const standard = unwrap(
      await renderDocumentsHtml([
        {
          meta: creditMeta,
          snapshot: {
            ...creditNote,
            deliveryNoteNumber: null,
            invoiceNumber: null,
            lines: [{ ...creditNote.lines[0]!, reduced: false, taxCategory: "standard" as const }],
            taxGroups: [{ category: "standard" as const, rateBps: 1000, subtotal: 150, tax: 15 }],
          },
        },
      ]),
    ).html;
    expect(standard).not.toContain("※は軽減税率");
    expect(standard).not.toContain("<th>請求書番号</th>");
  });

  it("請求書で差し引けない返品の返還請求書（請求書に載っていない返品。請求書番号なし）も記載事項を載せる（スナップショット）", async () => {
    const unbilled: CreditNoteSnapshot = {
      ...creditNote,
      number: "CN-2026-000008",
      invoiceNumber: null,
      lines: [
        creditNote.lines[0]!,
        {
          itemCode: "IT000002",
          name: "紙袋（大）",
          quantity: 2,
          unitName: "枚",
          unitPriceCenti: 10_000,
          amount: 200,
          taxCategory: "standard",
          reduced: false,
        },
      ],
      taxGroups: [
        { category: "standard", rateBps: 1000, subtotal: 200, tax: 20 },
        { category: "reduced", rateBps: 800, subtotal: 150, tax: 12 },
      ],
      subtotal: 350,
      tax: 32,
      total: 382,
    };
    const result = unwrap(
      await renderDocumentsHtml([
        { meta: { ...creditMeta, number: unbilled.number }, snapshot: unbilled },
      ]),
    );
    const html = result.html;
    expect(result.orientation).toBe("portrait");
    // 発行者の名称と登録番号、返品日と元の取引年月日、内容（軽減税率の対象である旨）、
    // 税率ごとの返還額の合計と適用税率、税率ごとの消費税額、宛名
    expect(html).toContain("架空菓子流通株式会社");
    expect(html).toContain("登録番号：T1234567890123");
    expect(html).toContain("返品日");
    expect(html).toContain("2026年10月10日");
    expect(html).toContain("元の取引年月日");
    expect(html).toContain("2026年10月5日");
    expect(html).toContain("テスト銘菓 うみねこサブレ 10枚入 ※");
    expect(html).toContain("※は軽減税率（8%）の対象です");
    expect(html).toContain("標準税率（10%）対象");
    expect(html).toContain("軽減税率（8%）対象");
    expect(html).toContain("消費税 ¥20");
    expect(html).toContain("消費税 ¥12");
    expect(html).toContain("返還額（税込） ¥382");
    expect(html).toContain("サンプル商店 &lt;本店&gt; 御中");
    expect(html).toContain("DN-2026-000010");
    expect(html).not.toContain("<th>請求書番号</th>");
    expect(html.replace(PRINT_CSS, "")).toMatchSnapshot();
  });
});
