import { describe, expect, it } from "vitest";

import { unwrap, unwrapErr } from "../../../../tests/support/result";
import type { DeliveryNoteSnapshot } from "../../../usecases/sales/snapshots";
import { PRINT_CSS } from "./layout";
import { renderDocumentsHtml } from "./registry";

const snapshot: DeliveryNoteSnapshot = {
  version: 1,
  number: "DN-2026-000123",
  shippedOn: "2026-11-02",
  salesOrderNumber: "SO-2026-000045",
  issuer: {
    name: "大船渡食品流通株式会社",
    registrationNumber: "T1234567890123",
    postalCode: "0220002",
    address: "岩手県大船渡市大船渡町1-2-3",
    phone: "0192-22-0000",
    fax: null,
    email: null,
  },
  customer: {
    name: "さかり商店 <本店>",
    honorific: "御中",
    postalCode: "0220003",
    address: "岩手県大船渡市盛町4-5",
    contactName: "佐藤",
  },
  lines: [
    {
      itemCode: "IT000001",
      name: "かもめの玉子 10個入",
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
  ],
  charges: [
    {
      description: "送料",
      quantity: 1,
      unitAmount: 800,
      amount: 800,
      taxCategory: "standard",
      reduced: false,
    },
  ],
  taxGroups: [
    { category: "standard", rateBps: 1000, subtotal: 1400, tax: 140 },
    { category: "reduced", rateBps: 800, subtotal: 451, tax: 36 },
  ],
  subtotal: 1851,
  tax: 176,
  total: 2027,
  roundingMode: "floor",
  memo: null,
};

const meta = {
  documentType: "delivery_note",
  number: snapshot.number,
  transactionDate: snapshot.shippedOn,
} as const;

describe("納品書のテンプレート", () => {
  it("A4 縦の HTML を作る（スナップショット）", async () => {
    const result = unwrap(await renderDocumentsHtml([{ meta, snapshot }]));
    expect(result.orientation).toBe("portrait");
    expect(result.html).toContain("<title>納品書 DN-2026-000123</title>");
    expect(result.html.replace(PRINT_CSS, "")).toMatchSnapshot();
  });

  it("インボイスの記載事項を載せる（発行者と登録番号・取引年月日・取引内容と軽減税率の対象・税率ごとの合計と消費税額・宛名）", async () => {
    const html = unwrap(await renderDocumentsHtml([{ meta, snapshot }])).html;
    expect(html).toContain("大船渡食品流通株式会社");
    expect(html).toContain("登録番号：T1234567890123");
    expect(html).toContain("2026年11月2日");
    expect(html).toContain("かもめの玉子 10個入 ※");
    expect(html).toContain("※は軽減税率（8%）の対象です");
    expect(html).toContain("標準税率（10%）対象");
    expect(html).toContain("軽減税率（8%）対象");
    expect(html).toContain("¥1,400");
    expect(html).toContain("消費税 ¥140");
    expect(html).toContain("消費税 ¥36");
    expect(html).toContain("合計金額（税込） ¥2,027");
    // 宛名は敬称つきで、値はエスケープする
    expect(html).toContain("さかり商店 &lt;本店&gt; 御中");
    expect(html).toContain("ご担当：佐藤 様");
    expect(html).toContain("¥150.50");
  });

  it("軽減税率の明細がなければ注記を出さない。スキーマに合わない内容は PDF にしない", async () => {
    const standardOnly: DeliveryNoteSnapshot = {
      ...snapshot,
      lines: snapshot.lines.filter((l) => !l.reduced),
      taxGroups: snapshot.taxGroups.filter((g) => g.category === "standard"),
      customer: { ...snapshot.customer, contactName: null },
      memo: "検品済み",
    };
    const html = unwrap(await renderDocumentsHtml([{ meta, snapshot: standardOnly }])).html;
    expect(html).not.toContain("※は軽減税率");
    expect(html).not.toContain("ご担当");
    expect(html).toContain("検品済み");
    const invalid = unwrapErr(
      await renderDocumentsHtml([{ meta, snapshot: { ...snapshot, total: "x" } }]),
    );
    expect(invalid.message).toContain("帳票の内容がテンプレートの形式と合いません");
  });
});
