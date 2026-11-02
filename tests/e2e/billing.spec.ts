import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";
import { registerItem, registerLocation, registerSupplier } from "./masters-helpers";
import { addStock, registerCustomer, registerSalesOrder } from "./sales-helpers";

/** 日本時間の今日から days 日後（YYYY-MM-DD） */
function jstDate(days = 0): string {
  return new Date(Date.now() + 9 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

/** 日本時間の前の月の day 日（YYYY-MM-DD） */
function lastMonthDay(day: number): string {
  const today = jstDate();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const d = new Date(Date.UTC(y, m - 1, day));
  return d.toISOString().slice(0, 10);
}

/** 前の月の初日と末日 */
function lastMonthRange(): { from: string; to: string } {
  const today = jstDate();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  return {
    from: new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
  };
}

async function setupItemAndStock(page: Page, prefix: string) {
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, prefix);
  const location = await registerLocation(page);
  await addStock(page, location, itemName, 10);
  return { itemName, location };
}

test("発送した受注から発送ごとの請求書を発行し、入金を記録して消し込むと入金済みになる", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy"))
      violations.push(message.text());
  });
  await login(page);
  const { itemName, location } = await setupItemAndStock(page, "E2E請求商品");
  const customer = await registerCustomer(page, "E2E請求先");
  await registerSalesOrder(page, { customer, location, itemName, quantity: 4 });
  await page.getByRole("button", { name: "発送する" }).click();
  await expect(page.getByText(/^発送しました/)).toBeVisible();

  // 受注詳細の発送の履歴から、未請求の発送の請求書の発行へ
  await page.getByRole("link", { name: "未請求", exact: true }).click();
  await expect(page.getByRole("heading", { name: "請求書の発行（発送ごと）" })).toBeVisible();
  // 123.45円 × 4 = 493.8 → 493円、軽減税率 8% の消費税 39円
  await expect(page.locator("#invoice-preview")).toContainText("¥532");
  await page.getByLabel("支払期限").fill(jstDate(30));
  await page.getByRole("button", { name: "請求書を発行する" }).click();
  const heading = page.getByRole("heading", { name: /^請求書 INV-\d{4}-\d{6}$/ });
  await expect(heading).toBeVisible();
  await expect(page.getByText("請求書を発行しました")).toBeVisible();
  await expect(page.locator("#invoice-detail")).toContainText("未入金");
  const invoiceNumber = ((await heading.textContent()) ?? "").replace("請求書 ", "");
  const invoiceUrl = page.url().replace(/\?.*$/, "");

  // 入金を記録して、請求書に消し込む
  await page.getByRole("link", { name: "入金を記録して消し込む" }).click();
  await expect(page.getByRole("heading", { name: "入金の記録と消込" })).toBeVisible();
  await expect(page.locator("#allocation-table")).toContainText(invoiceNumber);
  await page.getByLabel(/^入金額/).fill("532");
  await page.getByLabel(new RegExp(`^${invoiceNumber}に入金から充てる額`)).fill("532");
  await page.getByRole("button", { name: "入金を記録する" }).click();
  await expect(page.getByText("入金を記録しました")).toBeVisible();
  await expect(page.locator("#receipt-detail")).toContainText(invoiceNumber);
  await expect(page.locator("#receipt-detail")).toContainText("入金済み");

  await page.goto(invoiceUrl);
  await expect(page.locator("#invoice-detail")).toContainText("入金済み");
  await expect(page.getByRole("button", { name: "請求書を取り消す" })).toHaveCount(0);
  expect(violations).toEqual([]);
});

test("月締めの販売先の締め処理で、締め期間の発送をまとめて請求書にし、一括 PDF に進む", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await login(page);
  const { itemName, location } = await setupItemAndStock(page, "E2E締め商品");
  const customer = await registerCustomer(page, "E2E月締め先");
  const customerId = new URL(page.url()).pathname.split("/").at(-1) ?? "";

  // 取引条件：月末締め翌月末払い
  await page.getByLabel("締め日").selectOption({ label: "月末" });
  await page.getByLabel("支払月").selectOption({ label: "翌月" });
  await page.getByLabel("支払日").selectOption({ label: "月末" });
  await page.getByRole("button", { name: "取引条件を保存" }).click();
  await expect(page).toHaveURL(/notice=updated$/);
  await expect(page.getByLabel("締め日")).toHaveValue("31");

  // 前の月に2回受注して発送する（締め期間を過ぎている。発送日は受注日より前にできない）
  for (const day of [5, 20]) {
    await registerSalesOrder(page, {
      customer,
      location,
      itemName,
      quantity: 2,
      orderedOn: lastMonthDay(day),
      shipPlannedOn: lastMonthDay(day),
    });
    await page.getByLabel(/^発送日/).fill(lastMonthDay(day));
    await page.getByRole("button", { name: "発送する" }).click();
    await expect(page.getByText(/^発送しました/)).toBeVisible();
  }

  const period = lastMonthRange();
  await page.goto(`/invoices/closing?customerId=${customerId}`);
  const row = page.getByRole("row", { name: new RegExp(customer) });
  await expect(row).toContainText(`${period.from}〜${period.to}`);
  await expect(row).toContainText("締め処理待ち");
  await expect(row.getByRole("checkbox")).toBeChecked();
  await page.getByRole("button", { name: "選んだ販売先の請求書を発行する…" }).click();
  const panel = page.getByRole("region", { name: "締め処理の確認" });
  await expect(panel).toContainText(`${customer}：${period.from}〜${period.to}、発送 2 件`);
  await panel.getByRole("button", { name: "1 件の請求書を発行する" }).click();
  await expect(page.getByText("1 件の請求書を発行しました")).toBeVisible();
  // 締め処理を終えた販売先は、締め処理待ちから外れる
  await expect(page.getByRole("row", { name: new RegExp(customer) })).toHaveCount(0);

  await page.getByRole("button", { name: "発行した 1 件の請求書を一括で PDF にする" }).click();
  await expect(page).toHaveURL(/\/jobs\?notice=bulk$/);
  await expect(page.getByText("一括 PDF の作成を受け付けました")).toBeVisible();

  // 請求書一覧：締め期間と支払期限（翌月末）
  await page.goto(`/invoices?customerId=${customerId}`);
  await expect(page.locator("#results")).toContainText(`${period.from}〜${period.to}`);
  await expect(page.locator("#results")).toContainText("未入金");
});

test("請求書で差し引けない返品の返還請求書を発行し、返還額を入金の画面で返金済みにする", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await login(page);
  const { itemName, location } = await setupItemAndStock(page, "E2E返還商品");
  const customer = await registerCustomer(page, "E2E返還先");
  await registerSalesOrder(page, { customer, location, itemName, quantity: 4 });
  await page.getByRole("button", { name: "発送する" }).click();
  await expect(page.getByText(/^発送しました/)).toBeVisible();
  const orderUrl = page.url().replace(/\?.*$/, "");

  // 返品伝票（2個を廃棄）。どの請求書にも載っていない
  await page.getByRole("link", { name: "返品伝票を登録" }).click();
  await page.getByLabel(new RegExp(`^${itemName}の返品数`)).fill("2");
  await page.getByLabel(`${itemName}の扱い`).selectOption("dispose");
  await page.getByRole("button", { name: "返品伝票を登録する" }).click();
  await expect(page.getByRole("heading", { name: /^返品伝票 RT-\d{4}-\d{6}$/ })).toBeVisible();

  // 受注詳細から、返品伝票の返還請求書の欄へ移る
  await page.goto(orderUrl);
  await expect(page.locator("#so-returns")).toContainText("未請求（次の請求書に載せる）");
  await page
    .locator("#so-returns")
    .getByRole("link", { name: "返還請求書を発行（請求書で差し引けない返品）" })
    .click();
  await expect(page).toHaveURL(/\/sales-returns\/[0-9A-Z]{26}#credit-note$/);
  await page.getByRole("button", { name: "返還請求書を発行（請求書で差し引けない返品）" }).click();
  await expect(page.getByText(/返品は精算済みにし/)).toBeVisible();
  // 123.45円 × 2 = 246.9 → 246円、軽減税率 8% の消費税 19円
  await expect(page.locator("#return-detail")).toContainText("返還請求書で精算");
  await expect(page.locator(".credit-summary")).toContainText("¥265");

  // 返還額の入金：返還額と示し、残りを返金済みにする
  await page
    .getByRole("link", { name: "返還額の入金を開く（請求書に消し込む・返金済みにする）" })
    .click();
  await expect(page.getByRole("heading", { name: /^返還請求書の返還額 / })).toBeVisible();
  await expect(page.locator("#receipt-detail")).toContainText("未消込");
  await page.getByLabel(/^メモ/).last().fill("振込で返金");
  await page.getByRole("button", { name: "残りを返金済みにする" }).click();
  await expect(page.getByText("返還額の残りを返金済みにしました")).toBeVisible();
  await expect(page.locator("#receipt-detail")).toContainText("振込で返金");
  await expect(page.getByRole("button", { name: "残りを返金済みにする" })).toHaveCount(0);

  // 返金したので、返還請求書は取り消せない（先に返金を取り消す）
  await page.getByRole("link", { name: /^RT-\d{4}-\d{6}$/ }).click();
  await expect(page.locator("#credit-note")).toContainText("先に返金を取り消してください");
});
