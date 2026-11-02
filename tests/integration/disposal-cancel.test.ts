/**
 * 廃棄伝票の取消（要件定義書 3.12）。理由が必須、版番号・受付番号・操作履歴。在庫・請求には影響しない。
 * 取り消した伝票は一覧に「取消」の印つきで残り（絞り込みできる）、廃棄率の集計から外れる。
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { addDays } from "../../src/domain/dates";
import type { Result } from "../../src/domain/result";
import { businessDb } from "../../src/infra/do/client";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import { billingSetup, shipOrder } from "./billing-fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { readDb, systemCommandResult } from "./platform-helpers";
import { level, today } from "./sales-fixtures";

async function command<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string = newKey(),
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

async function disposalSetup() {
  const setup = await billingSetup();
  await shipOrder(setup, { lines: [{ itemId: setup.a.id, quantity: 10, unitPriceCenti: 15_050 }] });
  const kept = await systemCommand("disposals.create", {
    customerId: setup.customer.id,
    disposedOn: today(),
    lines: [{ itemId: setup.a.id, quantity: 1, reason: "expired" }],
  });
  const wrong = await systemCommand("disposals.create", {
    customerId: setup.customer.id,
    disposedOn: today(),
    lines: [{ itemId: setup.a.id, quantity: 4, reason: "damaged" }],
  });
  return { setup, kept, wrong };
}

describe("廃棄伝票の取消", () => {
  it("理由を入力して取り消すと、一覧に残り、廃棄率の集計から外れる。在庫・請求は変わらない", async () => {
    const { setup, kept, wrong } = await disposalSetup();
    const range = { from: addDays(today(), -1), to: today(), customerId: setup.customer.id };
    const before = await systemQuery("disposals.rates", range);
    expect(before.rows[0]).toMatchObject({ disposed: 5, shipped: 10, rateBps: 5000 });
    const stock = await level(setup.a.id, setup.locationId);
    const unbilled = (await systemQuery("invoices.unbilled", { customerId: setup.customer.id }))
      .total;

    // 権限：販売先廃棄の権限（受注・出荷担当・管理者）だけ
    const accounting = await createEmployee(["accounting"]);
    expect(
      await command(accounting, "disposals.cancel", { id: wrong.id, version: 1, reason: "誤り" }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    // 理由が必須・古い版は conflict・見つからなければ not_found
    expect(
      await systemCommandResult("disposals.cancel", { id: wrong.id, version: 1, reason: "" }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(
      await systemCommandResult("disposals.cancel", { id: wrong.id, version: 2, reason: "誤り" }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await systemCommandResult("disposals.cancel", { id: "missing", version: 1, reason: "誤り" }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });

    const sales = await createEmployee(["sales"]);
    const key = newKey();
    const input = { id: wrong.id, version: 1, reason: "数量の入力誤り" };
    const first = await command(sales, "disposals.cancel", input, key);
    expect(first).toEqual({ ok: true, value: { id: wrong.id, number: wrong.number } });
    expect(await command(sales, "disposals.cancel", input, key)).toEqual(first);

    const view = await systemQuery("disposals.get", { id: wrong.id });
    expect(view).toMatchObject({
      cancelled: true,
      cancelReason: "数量の入力誤り",
      cancelledAt: expect.any(String),
      cancelledByName: "テスト社員",
      version: 2,
    });
    expect(
      await systemCommandResult("disposals.cancel", { id: wrong.id, version: 2, reason: "x" }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_state", message: "この廃棄伝票はすでに取り消されています" },
    });
    // 廃棄率の集計から外れる
    const after = await systemQuery("disposals.rates", range);
    expect(after.rows[0]).toMatchObject({ disposed: 1, shipped: 10, rateBps: 1000 });
    // 在庫・請求は変わらない
    expect(await level(setup.a.id, setup.locationId)).toEqual(stock);
    expect((await systemQuery("invoices.unbilled", { customerId: setup.customer.id })).total).toBe(
      unbilled,
    );
    // 一覧には残る（取り消したものだけ・取り消していないものだけにも絞り込める）
    const list = (filter: { cancelled?: "exclude" | "only" }) =>
      systemQuery("disposals.list", { customerId: setup.customer.id, ...filter });
    expect((await list({})).rows.map((r) => [r.number, r.cancelled, r.cancelReason])).toEqual(
      expect.arrayContaining([
        [kept.number, false, null],
        [wrong.number, true, "数量の入力誤り"],
      ]),
    );
    expect((await list({ cancelled: "only" })).rows.map((r) => r.id)).toEqual([wrong.id]);
    expect((await list({ cancelled: "exclude" })).rows.map((r) => r.id)).toEqual([kept.id]);
    const audit = await readDb((db) =>
      db.query.auditLogs.findMany({ where: (l, { eq }) => eq(l.entityId, wrong.id) }),
    );
    expect(audit.map((l) => l.action)).toEqual(["create", "cancel"]);
  });

  it("画面：詳細で理由を入力して取り消し、一覧に取消の印と理由を出す。CSV にも出す", async () => {
    const { setup, wrong } = await disposalSetup();
    const sales = await createEmployee(["sales"]);
    const detail = await (await as(sales).get(`/disposals/${wrong.id}`)).text();
    expect(detail).toContain("廃棄伝票を取り消す");
    expect(detail).toContain(`/disposals/${wrong.id}/cancel`);
    const accounting = await createEmployee(["accounting"]);
    expect(await (await as(accounting).get(`/disposals/${wrong.id}`)).text()).not.toContain(
      "廃棄伝票を取り消す",
    );

    const noReason = await as(sales).hx(`/disposals/${wrong.id}/cancel`, {
      _key: newKey(),
      version: "1",
      reason: "",
    });
    const noReasonHtml = await noReason.text();
    expect(noReasonHtml).toContain('id="disposal-cancel"');
    expect(noReasonHtml).toContain("入力してください");
    const res = await as(sales).hx(`/disposals/${wrong.id}/cancel`, {
      _key: newKey(),
      version: "1",
      reason: "別の販売先の分だった",
    });
    expect(res.headers.get("HX-Redirect")).toBe(`/disposals/${wrong.id}?notice=cancelled`);
    const page = await (await as(sales).get(`/disposals/${wrong.id}?notice=cancelled`)).text();
    expect(page).toContain("廃棄伝票を取り消しました");
    expect(page).toContain("別の販売先の分だった");
    expect(page).not.toContain("廃棄伝票を取り消す");

    const list = await (await as(sales).get(`/disposals?customerId=${setup.customer.id}`)).text();
    expect(list).toContain("取消の理由：別の販売先の分だった");
    expect(list).toContain('<span class="badge badge-neutral">取消</span>');
    const only = await (
      await as(sales).get(`/disposals?customerId=${setup.customer.id}&cancelled=exclude`)
    ).text();
    expect(only).not.toContain(wrong.number);
    const csv = await (
      await as(sales).post("/disposals/csv", { _key: newKey(), customerId: setup.customer.id })
    ).text();
    expect(csv).toContain("取消,取消の理由");
    expect(csv).toContain(`${wrong.number},`);
    expect(csv).toContain("取消,別の販売先の分だった");
  });
});
