import { expect, type Page } from "@playwright/test";

import { unique } from "./helpers";

/** 仕入先を画面から登録して、その名前を返す */
export async function registerSupplier(page: Page): Promise<string> {
  const name = unique("E2E仕入先");
  await page.goto("/partners/new");
  await page.getByLabel("名称").fill(name);
  await page.getByLabel("読み仮名").fill("イーツーイーシイレサキ");
  await page.getByLabel("仕入先").check();
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return name;
}

/** 商品を画面から登録して、その名前を返す */
export async function registerItem(
  page: Page,
  supplier: string,
  prefix = "E2E商品",
): Promise<string> {
  const name = unique(prefix);
  await page.goto("/items/new");
  await page.getByLabel(/^商品名/).fill(name);
  await page.getByLabel(/^仕入先/).selectOption({ label: supplier });
  await page.getByLabel(/^税区分/).selectOption("reduced");
  await page.getByLabel(/^仕入単位/).fill("ケース");
  await page.getByLabel(/^販売単位/).fill("個");
  await page.getByLabel(/^入数/).fill("24");
  await page.getByLabel(/^仕入価格/).fill("2400");
  await page.getByLabel(/^卸単価/).fill("123.45");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return name;
}

/** 保管場所を画面から登録して、その名前を返す（管理者で操作する） */
export async function registerLocation(page: Page): Promise<string> {
  const name = unique("E2E倉庫");
  await page.goto("/masters/locations/new");
  await page.getByLabel(/^名前/).fill(name);
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.locator("#results")).toContainText(name);
  return name;
}
