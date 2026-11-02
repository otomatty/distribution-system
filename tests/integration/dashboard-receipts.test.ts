/**
 * ダッシュボードの「受注・出荷」の欄の「今日の入荷予定」（要件定義書 3.13）と、
 * そこから開く入荷予定一覧（納品希望日で絞り込む）。
 */
import { describe, expect, it } from "vitest";

import { addDays } from "../../src/domain/dates";
import { ADMIN_EMAIL, as, createEmployee, systemQuery } from "./helpers";
import { createConfirmedOrder, createOrder, purchasingSetup, receive } from "./purchasing-fixtures";
import { today } from "./sales-fixtures";

describe("今日の入荷予定", () => {
  it("納品希望日が今日で入荷が終わっていない発注を数え、今日で絞り込んだ入荷予定一覧へのリンクを出す", async () => {
    const before = await systemQuery("receipts.dueToday", {});
    const { supplierId, locationId, a, b } = await purchasingSetup();
    const due = await createConfirmedOrder({
      supplierId,
      locationId,
      deliveryRequestedOn: today(),
      lines: [
        { itemId: a.id, quantity: 2 },
        { itemId: b.id, quantity: 1 },
      ],
    });
    // 明日の発注・作成中の発注・入荷が終わった発注は数えない
    const tomorrow = await createConfirmedOrder({
      supplierId,
      locationId,
      deliveryRequestedOn: addDays(today(), 1),
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    await createOrder({
      supplierId,
      locationId,
      deliveryRequestedOn: today(),
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    const done = await createConfirmedOrder({
      supplierId,
      locationId,
      deliveryRequestedOn: today(),
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    await receive(done.id, [1], { receivedOn: today() });

    const after = await systemQuery("receipts.dueToday", {});
    expect(after.today).toBe(today());
    expect(after.count - before.count).toBe(1);

    const sales = await createEmployee(["sales"]);
    const page = await (await as(sales).get("/")).text();
    expect(page).toContain("今日の入荷予定");
    const href = `/receiving?on=${today()}`;
    expect(page).toContain(`href="${href}"`);
    // 仕入担当の欄には出さない（仕様の「仕入」の欄にはない）。管理者はすべての欄を見る
    const purchasing = await createEmployee(["purchasing"]);
    expect(await (await as(purchasing).get("/")).text()).not.toContain("今日の入荷予定");
    expect(await (await as(ADMIN_EMAIL).get("/")).text()).toContain("今日の入荷予定");

    const list = await (await as(sales).get(href)).text();
    expect(list).toContain(due.number);
    expect(list).not.toContain(tomorrow.number);
    expect(list).not.toContain(done.number);
    expect(list).toContain(`value="${today()}"`);
    const all = await (await as(sales).get("/receiving")).text();
    expect(all).toContain(tomorrow.number);
  });

  it("納品希望日の形式が正しくなければ一覧を出さない", async () => {
    const sales = await createEmployee(["sales"]);
    const res = await as(sales).get("/receiving?on=2026-13-45");
    expect(res.status).toBe(404);
  });
});
