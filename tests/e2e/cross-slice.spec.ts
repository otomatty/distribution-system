import { expect, test } from "@playwright/test";

import { login } from "./helpers";
import { registerItem, registerLocation, registerSupplier } from "./masters-helpers";
import { createAndConfirmOrder } from "./purchasing-helpers";
import { registerCustomer, registerSalesOrder } from "./sales-helpers";

test("発注 → 入荷 → 在庫に見える → 警告のない引当で受注 → 発送 → 納品書が帳票の検索に出る → 請求書を発行する", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy"))
      violations.push(message.text());
  });
  await login(page);
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, "E2E通し商品");
  const location = await registerLocation(page);
  const customer = await registerCustomer(page, "E2E通し販売先");

  // 発注（2ケース × 入数24）と入荷
  const po = await createAndConfirmOrder(page, supplier, itemName, location, "2");
  await page.getByRole("link", { name: "入荷を記録" }).click();
  await page.getByRole("button", { name: "入荷を記録する" }).click();
  await expect(page.getByText("この発注は入荷済みになりました")).toBeVisible();
  const receipt = (
    (await page
      .getByText(/RC-\d{4}-\d{6}/)
      .first()
      .textContent()) ?? ""
  ).trim();

  // 在庫一覧に48個。在庫明細の台帳から、入荷番号で発注へ戻れる
  await page.goto(`/stock?q=${encodeURIComponent(itemName)}`);
  const stockRow = page.locator("#results").getByRole("row", { name: new RegExp(location) });
  await expect(stockRow).toContainText("48");
  await stockRow.getByRole("link", { name: itemName }).click();
  await expect(page.getByRole("heading", { name: `在庫明細：${itemName}` })).toBeVisible();
  await page.getByRole("link", { name: `入荷 ${receipt}` }).click();
  await expect(page.getByRole("heading", { name: `発注 ${po}` })).toBeVisible();

  // 受注：在庫の範囲なので警告が出ない。引当で出荷可能数が減る
  const so = await registerSalesOrder(page, { customer, location, itemName, quantity: 10 });
  await expect(page.locator("#so-detail")).not.toContainText("を超えています");
  await expect(page.locator("#so-detail")).not.toContainText("最低ロット");
  await page.goto(`/stock?q=${encodeURIComponent(itemName)}`);
  await expect(
    page.locator("#results").getByRole("row", { name: new RegExp(location) }),
  ).toContainText("38");

  // 受注詳細から発送する（在庫を減らし、納品書を発行する）。確認ダイアログ（hx-confirm）は承認する
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/sales-orders");
  await page.getByRole("link", { name: so }).click();
  await page.getByRole("button", { name: "発送する" }).click();
  await expect(page.getByText("発送しました。納品書を発行しました")).toBeVisible();
  const note = (
    (await page
      .getByText(/DN-\d{4}-\d{6}/)
      .first()
      .textContent()) ?? ""
  ).trim();
  expect(note).toMatch(/^DN-\d{4}-\d{6}$/);

  // 在庫明細の台帳に、発送の行が納品書の番号で出る
  await page.goto(`/stock?q=${encodeURIComponent(itemName)}`);
  const after = page.locator("#results").getByRole("row", { name: new RegExp(location) });
  await expect(after).toContainText("38");
  await after.getByRole("link", { name: itemName }).click();
  await expect(page.getByRole("link", { name: `発送 ${note}` })).toBeVisible();

  // 帳票の検索に納品書が出る
  await page.goto("/documents");
  await page.getByLabel("番号").fill(note);
  await expect(page).toHaveURL(new RegExp(`number=${note}`));
  const docRow = page.locator("#results").getByRole("row", { name: new RegExp(note) });
  await expect(docRow).toContainText("納品書");
  await expect(docRow).toContainText(customer);

  // 続けて、受注詳細の未請求の発送から請求書を発行する（請求の画面を使う）
  await page.goto("/sales-orders");
  await page.getByRole("link", { name: so }).click();
  await page.getByRole("link", { name: "未請求", exact: true }).click();
  await expect(page.getByRole("heading", { name: "請求書の発行（発送ごと）" })).toBeVisible();
  const due = new Date(Date.now() + 9 * 3600_000 + 30 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel("支払期限").fill(due);
  await page.getByRole("button", { name: "請求書を発行する" }).click();
  const invoiceHeading = page.getByRole("heading", { name: /^請求書 INV-\d{4}-\d{6}$/ });
  await expect(invoiceHeading).toBeVisible();
  const invoice = ((await invoiceHeading.textContent()) ?? "").replace("請求書 ", "");
  await page.goto("/documents");
  await page.getByLabel("番号").fill(invoice);
  await expect(
    page.locator("#results").getByRole("row", { name: new RegExp(invoice) }),
  ).toContainText(customer);

  expect(violations).toEqual([]);
});
