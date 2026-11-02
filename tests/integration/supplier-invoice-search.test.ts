/**
 * 受け取った仕入先請求書の検索（要件定義書 7章 電子帳簿保存法）：取引年月日（請求日）・取引金額（請求額）・
 * 取引先（仕入先）で、範囲の指定と組み合わせで探せる。条件は URL に残し（hx-push-url）、CSV も同じ条件で出す。
 */
import { describe, expect, it } from "vitest";

import { createItem, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { createConfirmedOrder, receive } from "./purchasing-fixtures";

/** 1つの仕入先に、請求日と請求額の違う仕入先請求書を3枚 */
async function threeInvoices() {
  const supplierId = await createSupplier();
  const locationId = await createLocation();
  const item = await createItem(supplierId);
  const po = await createConfirmedOrder({
    supplierId,
    locationId,
    lines: [{ itemId: item.id, quantity: 3 }],
    orderedOn: "2026-08-01",
  });
  const invoices: { id: string; number: string }[] = [];
  for (const [i, [date, amount]] of (
    [
      ["2026-08-31", 1000],
      ["2026-09-30", 5000],
      ["2026-10-31", 9000],
    ] as const
  ).entries()) {
    const r = await receive(po.id, [1], { receivedOn: date });
    const number = `SRCH-${Date.now().toString(36)}-${i}`;
    const inv = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceNumber: number,
      invoiceDate: date,
      invoicedAmount: amount,
      receiptIds: [r.id],
      differenceReason: "検索のテスト",
    });
    invoices.push({ id: inv.id, number });
  }
  return { supplierId, invoices };
}

describe("仕入先請求書の検索（電子帳簿保存法）", () => {
  it("請求額の範囲・請求日の範囲・仕入先を組み合わせて探せる", async () => {
    const { supplierId, invoices } = await threeInvoices();
    const [aug, sep, oct] = invoices;
    const ids = async (filter: Record<string, unknown>) =>
      (await systemQuery("supplierInvoices.list", { supplierId, ...filter })).rows.map((r) => r.id);
    expect(await ids({ amountMin: 5000 })).toEqual(expect.arrayContaining([sep?.id, oct?.id]));
    expect(await ids({ amountMin: 5000 })).not.toContain(aug?.id);
    expect(await ids({ amountMax: 5000 })).toEqual(expect.arrayContaining([aug?.id, sep?.id]));
    expect(await ids({ amountMax: 5000 })).not.toContain(oct?.id);
    expect(await ids({ amountMin: 2000, amountMax: 9000, from: "2026-09-01" })).toEqual(
      expect.arrayContaining([sep?.id, oct?.id]),
    );
    expect(await ids({ amountMin: 2000, amountMax: 8000, to: "2026-09-30" })).toEqual([sep?.id]);
    // ほかの仕入先の請求書は出ない
    const other = await systemQuery("supplierInvoices.list", {
      supplierId: await createSupplier(),
      amountMin: 0,
    });
    expect(other.total).toBe(0);
  });

  it("画面の絞り込みは条件を URL に残し、CSV も同じ条件で出す。範囲の逆転はエラーを出す", async () => {
    const user = await createEmployee(["accounting"]);
    const { supplierId, invoices } = await threeInvoices();
    const [aug, sep, oct] = invoices;
    const page = await (
      await as(user).get(
        `/supplier-invoices?supplierId=${supplierId}&amountMin=2,000&amountMax=8000&from=2026-09-01&to=2026-10-31`,
      )
    ).text();
    expect(page).toContain('hx-push-url="true"');
    expect(page).toContain('name="amountMin"');
    expect(page).toContain('value="2000"');
    expect(page).toContain(sep?.number);
    expect(page).not.toContain(aug?.number);
    expect(page).not.toContain(oct?.number);
    // CSV のボタンは今の条件を持つ
    expect(page).toContain('<input type="hidden" name="amountMax" value="8000"/>');
    const csv = await (
      await as(user).post("/supplier-invoices/csv", {
        _key: newKey(),
        supplierId,
        amountMin: "2000",
        amountMax: "8000",
        from: "2026-09-01",
      })
    ).text();
    expect(csv).toContain(sep?.number);
    expect(csv).not.toContain(aug?.number);
    expect(csv).not.toContain(oct?.number);

    const reversed = await (
      await as(user).get(`/supplier-invoices?supplierId=${supplierId}&amountMin=9000&amountMax=1`)
    ).text();
    expect(reversed).toContain("上限の金額は下限の金額以上にしてください");
    const bad = await (
      await as(user).get(`/supplier-invoices?supplierId=${supplierId}&amountMin=abc`)
    ).text();
    expect(bad).toContain("金額は数字で入力してください");
    const dates = await (
      await as(user).get(
        `/supplier-invoices?supplierId=${supplierId}&from=2026-10-01&to=2026-09-01`,
      )
    ).text();
    expect(dates).toContain("終わりの日付は始まりの日付以降にしてください");
  });
});
