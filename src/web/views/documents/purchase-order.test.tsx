import { describe, expect, it } from "vitest";

import { unwrap, unwrapErr } from "../../../../tests/support/result";
import type { PurchaseOrderSnapshot } from "../../../usecases/purchasing/snapshots";
import { purchaseOrderTemplate } from "./purchase-order";
import { documentTemplates, renderDocumentsHtml } from "./registry";

const snapshot: PurchaseOrderSnapshot = {
  number: "PO-2026-000123",
  orderedOn: "2026-11-02",
  deliveryRequestedOn: "2026-11-10",
  paymentDueOn: "2026-12-31",
  issuer: {
    name: "テスト流通株式会社",
    registrationNumber: "T1234567890123",
    postalCode: "0220002",
    address: "岩手県大船渡市大船渡町1-1",
    phone: "0192-00-0000",
    fax: "0192-00-0001",
    email: "order@example.co.jp",
  },
  supplier: {
    name: "架空製菓",
    honorific: "御中",
    contactName: "山田",
    postalCode: "0200001",
    address: "岩手県盛岡市1-2-3",
    phone: null,
    fax: "019-000-0000",
  },
  destination: {
    kind: "location",
    name: "本社倉庫",
    postalCode: "0220002",
    address: "岩手県大船渡市大船渡町2-2",
    phone: "0192-00-0002",
  },
  employeeName: "仕入 太郎",
  lines: [
    {
      no: 1,
      itemCode: "IT000001",
      itemName: "テスト銘菓 うみねこ <10個入>",
      jan: "4901234567894",
      quantity: 3,
      purchaseUnitName: "ケース",
      unitsPerPurchaseUnit: 12,
      salesUnitName: "箱",
      unitPriceCenti: 123_456,
      amount: 3703,
      taxCategory: "reduced",
      memo: "賞味期限の長いもの",
    },
    {
      no: 2,
      itemCode: "IT000002",
      itemName: "紙袋（大）",
      jan: null,
      quantity: 2,
      purchaseUnitName: "束",
      unitsPerPurchaseUnit: 50,
      salesUnitName: "枚",
      unitPriceCenti: 50_000,
      amount: 1000,
      taxCategory: "standard",
      memo: null,
    },
  ],
  taxGroups: [
    { category: "standard", rateBps: 1000, subtotal: 1000, tax: 100 },
    { category: "reduced", rateBps: 800, subtotal: 3703, tax: 296 },
  ],
  subtotal: 4703,
  tax: 396,
  total: 5099,
  memo: "午前中に納品してください",
};

const meta = {
  documentType: "purchase_order",
  number: "PO-2026-000123",
  transactionDate: "2026-11-02",
} as const;

describe("発注書のテンプレート", () => {
  it("登録されていて、A4 縦の印刷用 HTML を作る（スナップショット）", async () => {
    expect(documentTemplates.purchase_order).toBe(purchaseOrderTemplate);
    const result = unwrap(await renderDocumentsHtml([{ meta, snapshot }]));
    expect(result.orientation).toBe("portrait");
    expect(result.html).toContain("<title>発注書 PO-2026-000123</title>");
    expect(result.html).toMatchSnapshot();
  });

  it("発行者・登録番号・取引年月日・内容（軽減税率の印）・税率ごとの合計と消費税・宛名を載せる", async () => {
    const html = unwrap(await renderDocumentsHtml([{ meta, snapshot }])).html;
    expect(html).toContain("テスト流通株式会社");
    expect(html).toContain("登録番号：T1234567890123");
    expect(html).toContain("2026年11月2日");
    expect(html).toContain("架空製菓 御中");
    expect(html).toContain("ご担当：山田 様");
    // 値はエスケープされる
    expect(html).toContain("テスト銘菓 うみねこ &lt;10個入&gt; ※");
    expect(html).toContain("※は軽減税率の対象です");
    expect(html).toContain("10%対象");
    expect(html).toContain("8%対象（軽減税率）");
    expect(html).toContain("消費税 ¥296");
    expect(html).toContain("¥5,099");
    expect(html).toContain("¥1,234.56");
    expect(html).toContain("本社倉庫");
    expect(html).toContain("2026年11月10日");
    expect(html).toContain("午前中に納品してください");
  });

  it("その他の届け先は入力した名前と住所を行ごとに出す。形式の合わない内容は失敗にする", async () => {
    const other = unwrap(
      await renderDocumentsHtml([
        {
          meta,
          snapshot: {
            ...snapshot,
            deliveryRequestedOn: null,
            paymentDueOn: null,
            memo: null,
            supplier: { ...snapshot.supplier, contactName: null },
            destination: {
              kind: "other",
              name: null,
              postalCode: null,
              address: "イベント会場\n岩手県大船渡市",
              phone: null,
            },
            lines: [{ ...snapshot.lines[1]!, no: 1 }],
            taxGroups: [snapshot.taxGroups[0]!],
          },
        },
      ]),
    ).html;
    expect(other).toContain("<div>イベント会場</div><div>岩手県大船渡市</div>");
    expect(other).not.toContain("納品希望日");
    expect(other).not.toContain("軽減税率の対象");
    const broken = unwrapErr(
      await renderDocumentsHtml([{ meta, snapshot: { ...snapshot, total: "5099" } }]),
    );
    expect(broken.message).toContain("帳票の内容がテンプレートの形式と合いません");
  });
});
