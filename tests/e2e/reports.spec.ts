import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { login } from "./helpers";
import { registerItem, registerLocation, registerSupplier } from "./masters-helpers";
import { addStock, registerCustomer, registerSalesOrder } from "./sales-helpers";

test("売上・仕入の集計：発送した受注が販売先別・商品別に出て、名前で絞り込み、CSV を出せる", async ({
  page,
}) => {
  // 発送の確認ダイアログ（hx-confirm）は承認する
  page.on("dialog", (dialog) => void dialog.accept());
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy"))
      violations.push(message.text());
  });
  await login(page);
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, "E2E集計商品");
  const location = await registerLocation(page);
  const customer = await registerCustomer(page, "E2E集計販売先");
  await addStock(page, location, itemName, 10);
  await registerSalesOrder(page, { customer, location, itemName, quantity: 4 });
  await page.getByRole("button", { name: "発送する" }).click();
  await expect(page.getByText(/^発送しました/)).toBeVisible();

  // メニューから集計の画面へ。既定は今月までの12か月の、販売先別の売上
  await page.getByRole("link", { name: "売上・仕入の集計" }).click();
  await expect(page.getByRole("heading", { name: "売上・仕入の集計" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "月ごとの売上と仕入" })).toBeVisible();
  await expect(page.getByLabel("表示")).toHaveValue("sales_customer");

  // 名前で絞り込むと、表の部分だけが変わる（123.45円 × 4 = 493.8円 → 493円、税抜）
  const results = page.locator("#results");
  await page.getByLabel("名前・コードで絞り込み").fill(customer);
  const row = results.getByRole("row", { name: new RegExp(customer) });
  await expect(row).toContainText("493");
  await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(customer)}`));

  // 商品別に切り替える（送料などは含めない旨を表示する）
  await page.getByLabel("名前・コードで絞り込み").fill(itemName);
  await page.getByLabel("表示").selectOption("sales_item");
  await expect(results.getByRole("heading", { name: "売上（商品別）" })).toBeVisible();
  await expect(results.getByRole("row", { name: new RegExp(itemName) })).toContainText("493");
  await expect(results).toContainText("送料などは商品に割り振れないため含めていません");
  await expect(page).toHaveURL(/view=sales_item/);

  // 集計の基準を開く
  await page.getByText("集計の基準").click();
  await expect(page.getByText(/売上：発送日の月に/)).toBeVisible();

  // CSV：行 × 月を縦に並べる
  const downloading = page.waitForEvent("download");
  await results.getByRole("button", { name: "CSV 出力" }).click();
  const download = await downloading;
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain("集計,区分,コード,名前,月,金額（税抜）");
  expect(csv).toMatch(new RegExp(`売上,商品,IT\\d+,${itemName},\\d{4}-\\d{2},493`));
  expect(violations).toEqual([]);
});
