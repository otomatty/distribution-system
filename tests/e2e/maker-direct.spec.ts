import { expect, test } from "@playwright/test";

import { login } from "./helpers";
import { registerItem, registerSupplier } from "./masters-helpers";
import { pickItem, registerCustomer } from "./sales-helpers";

test("メーカー直の受注から、初期値の入った発注を作って確定し、受注と発注を相互に行き来する", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await login(page);
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, "E2Eメーカー直商品");
  const customer = await registerCustomer(page, "E2Eメーカー直販売先");

  // メーカー直の受注（入数24の商品を30個。在庫は動かさない）
  await page.goto("/sales-orders/new");
  await page.getByLabel(/^販売先/).selectOption({ label: customer });
  await page.getByRole("checkbox", { name: /メーカー直（仕入先から直送/ }).check();
  await page.getByLabel("納品希望日").fill("2026-12-15");
  await pickItem(page, itemName, "#so-lines");
  const quantity = page.getByLabel(`${itemName}の数量`, { exact: true });
  await quantity.fill("30");
  await quantity.blur();
  await page.getByRole("button", { name: "登録する" }).click();
  const heading = page.getByRole("heading", { name: /^受注 SO-\d{4}-\d{6}$/ });
  await expect(heading).toBeVisible();
  const so = ((await heading.textContent()) ?? "").replace("受注 ", "");

  // 受注詳細の「メーカー直の発注」から、仕入先への発注を作る
  const section = page.locator("#so-maker-direct");
  await expect(section).toContainText("この受注から作った発注はまだありません");
  await section.getByRole("link", { name: `${supplier}への発注を作る` }).click();
  await expect(page.getByRole("heading", { name: "発注の作成（メーカー直）" })).toBeVisible();
  await expect(page.getByText(`受注 ${so}`)).toBeVisible();
  // 30個 → 2ケース（48個。18個多い）、納入先は受注の販売先、納品希望日は受注の値
  await expect(page.getByText("受注 30個 → 発注 2ケース（48個）")).toBeVisible();
  await expect(page.getByText("18個多い")).toBeVisible();
  await expect(page.getByLabel(`${itemName}の数量（ケース）`)).toHaveValue("2");
  await expect(page.getByRole("radio", { name: "販売先（メーカー直）" })).toBeChecked();
  await expect(page.getByLabel("販売先（メーカー直。在庫に入れない）")).toHaveValue(/.+/);
  await expect(page.getByLabel("納品希望日")).toHaveValue("2026-12-15");
  // 発注の数量を直してから保存する
  const poQuantity = page.getByLabel(`${itemName}の数量（ケース）`);
  await poQuantity.fill("1");
  await poQuantity.blur();
  await expect(page.locator("#po-total")).toHaveText("¥2,592");
  await page.getByRole("button", { name: "作成中として保存" }).click();
  const poHeading = page.getByRole("heading", { name: /^発注 PO-\d{4}-\d{6}$/ });
  await expect(poHeading).toBeVisible();
  const po = ((await poHeading.textContent()) ?? "").replace("発注 ", "");
  await expect(page.getByText(`販売先（メーカー直）：${customer}`)).toBeVisible();

  // 確定する
  await page.getByLabel("送付方法").selectOption("none");
  await page.getByRole("button", { name: "確定して送付する" }).click();
  await expect(page.getByText("発注を確定しました")).toBeVisible();

  // 発注詳細から受注へ、受注詳細から発注へ
  await page.getByRole("link", { name: so }).click();
  await expect(heading).toBeVisible();
  await expect(section).toContainText(po);
  await expect(section).toContainText("発注済み");
  await expect(section.getByRole("link", { name: `${supplier}への発注を作る` })).toHaveCount(0);
  // 発注の一覧と「発注済み」の両方にリンクがある
  await expect(section.getByRole("link", { name: po })).toHaveCount(2);
  await section.getByRole("link", { name: po }).first().click();
  await expect(poHeading).toBeVisible();

  // メーカー直の発注は入荷予定一覧の「メーカー直・その他の届け先」に出る（納品済みの確認だけ）
  await page.goto("/receiving");
  await expect(page.locator("#results")).toContainText(po);
});
