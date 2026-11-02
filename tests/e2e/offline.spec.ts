/// <reference lib="dom" />
// ブラウザの中で動かす関数（waitForFunction）で caches・navigator.serviceWorker の型を使う
import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";
import { registerItem, registerLocation, registerSupplier } from "./masters-helpers";
import { addStock, registerCustomer, registerSalesOrder } from "./sales-helpers";

const CACHE = "offline-snapshots-v1";

/** service worker がこの画面を受け持つまで待つ */
async function waitForWorker(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/** service worker が、画面（path）を text を含む内容で残すまで待つ */
async function waitForSnapshot(page: Page, path: string, text: string): Promise<void> {
  await page.waitForFunction(
    async ([cacheName, key, expected]) => {
      const cache = await caches.open(cacheName);
      const response = await cache.match(new URL(key, location.origin).href);
      return response ? (await response.text()).includes(expected) : false;
    },
    [CACHE, path, text] as const,
  );
}

test("発送リストと入荷予定一覧は、最後に読み込んだ内容を通信が途切れても表示し、ログアウトで消す @tablet", async ({
  page,
  context,
}) => {
  await login(page);
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, "E2Eオフライン商品");
  const location = await registerLocation(page);
  const customer = await registerCustomer(page, "E2Eオフライン販売先");
  await addStock(page, location, itemName, 5);
  await registerSalesOrder(page, { customer, location, itemName, quantity: 2 });

  // 発送リスト：保管場所で絞り込んだ内容（最後に読み込んだもの）を残す
  await page.goto("/shipping");
  await waitForWorker(page);
  await page.getByLabel("保管場所").selectOption({ label: location });
  await expect(page).toHaveURL(/locationId=/);
  await expect(page.locator(".shipping-matrix")).toContainText(customer);
  const loadedAt = (await page.locator(".snapshot-time").textContent()) ?? "";
  expect(loadedAt).toMatch(/^読み込んだ時刻：\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  await waitForSnapshot(page, "/shipping", customer);

  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText("通信が途切れているため、この時刻に読み込んだ内容を表示しています"),
  ).toBeVisible();
  await expect(page.locator(".snapshot-time")).toHaveText(loadedAt);
  await expect(page.locator(".shipping-matrix")).toContainText(customer);
  await expect(page.locator(".shipping-matrix")).toContainText(itemName);
  // 残した画面からは操作できない
  await expect(page.getByRole("button", { name: "選んだ受注を一括発送する…" })).toBeDisabled();
  await expect(page.getByLabel("保管場所")).toBeDisabled();
  await context.setOffline(false);

  // 入荷予定一覧も同じ
  await page.goto("/receiving");
  await waitForWorker(page);
  await page.reload();
  const receivingAt = (await page.locator(".snapshot-time").textContent()) ?? "";
  await waitForSnapshot(page, "/receiving", receivingAt.replace("読み込んだ時刻：", ""));
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText("通信が途切れているため、この時刻に読み込んだ内容を表示しています"),
  ).toBeVisible();
  await expect(page.locator(".snapshot-time")).toHaveText(receivingAt);
  await context.setOffline(false);

  // 通信が戻れば、いつもの画面（注意は出ない）
  await page.reload();
  await expect(page.getByText("通信が途切れているため")).toBeHidden();

  // ログアウトすると、残した画面と service worker の登録を消す（共有のタブレット）
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByText("ログアウトしました")).toBeVisible();
  await page.waitForFunction(
    async () =>
      (await caches.keys()).length === 0 &&
      (await navigator.serviceWorker.getRegistrations()).length === 0,
  );
  await context.setOffline(true);
  await expect(page.goto("/shipping")).rejects.toThrow();
  await context.setOffline(false);
});
