import { describe, expect, it } from "vitest";

import { createItem, createSupplier, uniqueName } from "./fixtures";
import {
  as,
  anonymous,
  createEmployee,
  newKey,
  ORIGIN,
  systemCommand,
  systemQuery,
} from "./helpers";

const baseForm = {
  name: "株式会社テスト製菓",
  kana: "テストセイカ",
  honorific: "御中",
  isSupplier: "on",
  deliveryDays: "2",
  defaultSendMethod: "none",
  postalCode: "022-0002",
  phone: "0192-00-0000",
};

describe("取引先の画面", () => {
  it("ログインしていなければログイン画面へ移動する", async () => {
    const res = await anonymous().get("/partners");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("画面は <!DOCTYPE html> から始まる（互換モードで描画させない）", async () => {
    const user = await createEmployee(["purchasing"]);
    const page = await (await as(user).get("/partners")).text();
    expect(page.startsWith("<!DOCTYPE html>")).toBe(true);
    const login = await (await anonymous().get("/login")).text();
    expect(login.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("登録されていない社員は利用できない", async () => {
    const res = await as("unknown@example.co.jp").get("/partners");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/no-access");
  });

  it("仕入担当は取引先を登録でき、詳細に表示される", async () => {
    const user = await createEmployee(["purchasing"]);
    const res = await as(user).hx("/partners/new", { ...baseForm, _key: newKey() });
    expect(res.status).toBe(204);
    const location = res.headers.get("HX-Redirect");
    expect(location).toMatch(/^\/partners\/[0-9A-Z]{26}\?notice=created$/);
    const detail = await as(user).get(location ?? "");
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain("株式会社テスト製菓");
    expect(html).toContain("022-0002");
  });

  it("同じ受付番号で2回送信しても1件だけ登録される", async () => {
    const user = await createEmployee(["sales"]);
    const key = newKey();
    const form = {
      ...baseForm,
      name: "二重送信テスト商店",
      isSupplier: "",
      isCustomer: "on",
      _key: key,
    };
    const first = await as(user).hx("/partners/new", form);
    const second = await as(user).hx("/partners/new", form);
    expect(second.headers.get("HX-Redirect")).toBe(first.headers.get("HX-Redirect"));
    const list = await systemQuery("partners.list", { q: "二重送信テスト", page: 1 });
    expect(list.total).toBe(1);
  });

  it("入力に誤りがあれば、項目ごとのエラーを表示する", async () => {
    const user = await createEmployee(["purchasing"]);
    const res = await as(user).hx("/partners/new", {
      ...baseForm,
      name: "",
      isSupplier: "",
      _key: newKey(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("入力内容を確認してください");
    expect(html).toContain("仕入先・販売先の少なくとも一方を選んでください");
  });

  it("経理担当は取引先を登録できない（権限）", async () => {
    const user = await createEmployee(["accounting"]);
    const res = await as(user).hx("/partners/new", { ...baseForm, _key: newKey() });
    const html = await res.text();
    expect(html).toContain("この操作を行う権限がありません");
  });

  it("経理担当は締め日と支払条件を設定でき、仕入担当は設定できない", async () => {
    const accounting = await createEmployee(["accounting"]);
    const purchasing = await createEmployee(["purchasing"]);
    const created = await systemCommand("partners.create", {
      name: "条件テスト",
      kana: "ジョウケンテスト",
      isSupplier: true,
    });
    const partner = await systemQuery("partners.get", { id: created.id });
    expect(partner).toBeTruthy();
    const form = {
      version: String(partner?.version ?? 0),
      registrationNumber: "T1234567890123",
      closingDay: "31",
      paymentMonthOffset: "1",
      paymentDay: "31",
      _key: newKey(),
    };
    const denied = await as(purchasing).hx(`/partners/${created.id}/terms`, form);
    expect(await denied.text()).toContain("権限がありません");
    const res = await as(accounting).hx(`/partners/${created.id}/terms`, {
      ...form,
      _key: newKey(),
    });
    expect(res.status).toBe(204);
    const updated = await systemQuery("partners.get", { id: created.id });
    expect(updated?.registrationNumber).toBe("T1234567890123");
    expect(updated?.closingDay).toBe(31);
  });

  it("古い版番号での保存は競合として扱う", async () => {
    const user = await createEmployee(["purchasing"]);
    const created = await systemCommand("partners.create", {
      name: "版番号テスト",
      kana: "ハンバンゴウ",
      isSupplier: true,
    });
    const ok = await as(user).hx(`/partners/${created.id}/edit`, {
      ...baseForm,
      name: "版番号テスト2",
      version: "1",
      _key: newKey(),
    });
    expect(ok.status).toBe(204);
    const stale = await as(user).hx(`/partners/${created.id}/edit`, {
      ...baseForm,
      name: "版番号テスト3",
      version: "1",
      _key: newKey(),
    });
    expect(await stale.text()).toContain("ほかの人が先に更新");
  });

  it("使われていない取引先は版番号が一致すれば削除でき、使われている取引先は削除できない", async () => {
    const user = await createEmployee(["purchasing"]);
    const unused = await systemCommand("partners.create", {
      name: uniqueName("削除テスト"),
      kana: "サクジョ",
      isSupplier: true,
    });
    const detail = await (await as(user).get(`/partners/${unused.id}`)).text();
    expect(detail).toMatch(
      /action="\/partners\/[0-9A-Z]{26}\/delete"[\s\S]*?name="version" value="1"/,
    );
    // 開いた後にほかの人が更新していたら、古い版番号での削除は競合にする
    await systemCommand("partners.archive", { id: unused.id, version: 1, archived: false });
    const stale = await as(user).post(`/partners/${unused.id}/delete`, {
      version: "1",
      _key: newKey(),
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("ほかの人が先に更新しました");
    expect(await systemQuery("partners.get", { id: unused.id })).not.toBeNull();

    const deleted = await as(user).post(`/partners/${unused.id}/delete`, {
      version: "2",
      _key: newKey(),
    });
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get("Location")).toBe("/partners?notice=deleted");
    expect(await systemQuery("partners.get", { id: unused.id })).toBeNull();

    const used = await createSupplier();
    await createItem(used);
    const refused = await as(user).post(`/partners/${used}/delete`, {
      version: "1",
      _key: newKey(),
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("取引終了");
    expect(await systemQuery("partners.get", { id: used })).not.toBeNull();

    const accounting = await createEmployee(["accounting"]);
    const forbidden = await as(accounting).post(`/partners/${used}/delete`, {
      version: "1",
      _key: newKey(),
    });
    expect(await forbidden.text()).toContain("権限がありません");
  });

  it("別のサイトからの POST は拒否する（CSRF）", async () => {
    const user = await createEmployee(["purchasing"]);
    const res = await as(user).post(
      "/partners/new",
      { ...baseForm, _key: newKey() },
      { Origin: "https://evil.example.com" },
    );
    expect(res.status).toBe(403);
    expect(ORIGIN).toBe("http://localhost:8787");
  });
});
