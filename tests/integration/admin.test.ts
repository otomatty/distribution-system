import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { businessDb } from "../../src/infra/do/client";
import { uniqueName } from "./fixtures";
import { ADMIN_EMAIL, as, createEmployee, newKey, systemQuery } from "./helpers";

describe("社員管理の画面", () => {
  it("管理者以外は開けない", async () => {
    const purchasing = await createEmployee(["purchasing", "sales", "accounting"]);
    expect((await as(purchasing).get("/admin/employees")).status).toBe(403);
    expect((await as(purchasing).get("/admin/employees/new")).status).toBe(403);
    expect((await as(purchasing).get("/admin/settings")).status).toBe(403);
    const post = await as(purchasing).hx("/admin/employees/new", {
      email: "x@example.co.jp",
      name: "x",
      roles: "admin",
      _key: newKey(),
    });
    expect(post.status).toBe(403);
  });

  it("管理者は社員を登録し、Google アカウントの連携状況を確かめられる", async () => {
    const admin = await createEmployee(["admin"]);
    const email = `${uniqueName("new").toLowerCase()}@example.co.jp`;
    const res = await as(admin).hx("/admin/employees/new", {
      email: email.toUpperCase(),
      name: "新しい社員",
      roles: ["purchasing", "sales"],
      _key: newKey(),
    });
    expect(res.headers.get("HX-Redirect")).toBe("/admin/employees?notice=created");
    const list = await (await as(admin).get("/admin/employees?notice=created")).text();
    expect(list).toContain(email);
    expect(list).toContain("未ログイン");
    expect(list).toContain("仕入担当");
    const employee = (await systemQuery("employees.list", {})).find((e) => e.email === email);
    expect(employee?.roles).toEqual(["purchasing", "sales"]);

    const dup = await as(admin).hx("/admin/employees/new", {
      email,
      name: "重複",
      roles: "sales",
      _key: newKey(),
    });
    expect(await dup.text()).toContain("このメールアドレスはすでに登録されています");
    const noRole = await as(admin).hx("/admin/employees/new", {
      email: `${uniqueName("r").toLowerCase()}@example.co.jp`,
      name: "役割なし",
      _key: newKey(),
    });
    expect(await noRole.text()).toContain("役割を1つ以上選んでください");
  });

  it("役割の変更と無効化ができ、版番号の競合を検出する", async () => {
    const admin = await createEmployee(["admin"]);
    const target = await createEmployee(["sales"], "役割変更テスト");
    const employee = (await systemQuery("employees.list", {})).find((e) => e.email === target);
    const id = employee?.id ?? "";
    const page = await (await as(admin).get(`/admin/employees/${id}`)).text();
    expect(page).toContain("役割変更テスト");
    const res = await as(admin).hx(`/admin/employees/${id}`, {
      name: "役割変更テスト",
      roles: ["accounting"],
      version: "1",
      _key: newKey(),
    });
    expect(res.headers.get("HX-Redirect")).toBe(`/admin/employees/${id}?notice=updated`);
    const updated = await systemQuery("employees.get", { id });
    expect(updated?.roles).toEqual(["accounting"]);
    expect(updated?.active).toBe(false);
    // 無効にした社員は次の操作から使えない
    expect((await as(target).get("/items")).headers.get("Location")).toBe("/no-access");
    const stale = await as(admin).hx(`/admin/employees/${id}`, {
      name: "古い画面",
      roles: ["sales"],
      active: "on",
      version: "1",
      _key: newKey(),
    });
    expect(await stale.text()).toContain("ほかの人が先に更新しました");
    expect((await as(admin).get("/admin/employees/NOPE")).status).toBe(404);
    const missing = await businessDb(env).command(
      "employees.update",
      { id: "NOPE", version: 1, name: "x", roles: ["sales"], active: true },
      { kind: "system" },
      null,
    );
    expect(missing.ok ? null : missing.error.code).toBe("not_found");
    expect(
      (await as(admin).hx("/admin/employees/NOPE", { name: "x", version: "1", _key: newKey() }))
        .status,
    ).toBe(404);
  });

  it("最後の管理者は管理者でなくせない", async () => {
    const admins = (await systemQuery("employees.list", {})).filter(
      (e) => e.active && e.roles.includes("admin"),
    );
    // 初期の管理者以外の管理者を無効にしてから確かめる
    const initial = admins.find((e) => e.email === ADMIN_EMAIL);
    for (const a of admins.filter((e) => e.email !== ADMIN_EMAIL)) {
      await as(ADMIN_EMAIL).hx(`/admin/employees/${a.id}`, {
        name: a.name,
        roles: [...a.roles],
        version: String(a.version),
        _key: newKey(),
      });
    }
    const res = await as(ADMIN_EMAIL).hx(`/admin/employees/${initial?.id ?? ""}`, {
      name: "管理者",
      roles: ["sales"],
      active: "on",
      version: String(initial?.version ?? 1),
      _key: newKey(),
    });
    expect(await res.text()).toContain("有効な管理者が1人もいなくなるため変更できません");
  });
});

describe("設定の画面", () => {
  it("自社情報と端数処理を保存でき、登録番号の形式を検証する", async () => {
    const admin = await createEmployee(["admin"]);
    const page = await (await as(admin).get("/admin/settings")).text();
    expect(page).toContain("自社情報");
    expect(page).toContain("適用中");
    const settings = await systemQuery("settings.get", {});
    const bad = await as(admin).hx("/admin/settings/company", {
      version: String(settings.company.version),
      name: "株式会社テスト",
      registrationNumber: "T123",
      roundingMode: "round",
      _key: newKey(),
    });
    expect(await bad.text()).toContain("登録番号は T と13桁の数字で入力してください");
    const ok = await as(admin).hx("/admin/settings/company", {
      version: String(settings.company.version),
      name: "株式会社テスト",
      registrationNumber: "t1234567890123",
      postalCode: "0220002",
      bankInfo: "テスト銀行 本店 普通 1234567",
      roundingMode: "round",
      _key: newKey(),
    });
    expect(ok.headers.get("HX-Redirect")).toBe("/admin/settings?notice=updated");
    const after = await systemQuery("settings.get", {});
    expect(after.company.registrationNumber).toBe("T1234567890123");
    expect(after.company.roundingMode).toBe("round");
    const stale = await as(admin).hx("/admin/settings/company", {
      version: String(settings.company.version),
      name: "古い画面",
      roundingMode: "floor",
      _key: newKey(),
    });
    expect(await stale.text()).toContain("ほかの人が先に更新しました");
    // 登録番号を省いた入力（空として扱う）
    const r = await businessDb(env).command(
      "settings.updateCompany",
      { version: after.company.version, name: "株式会社テスト", roundingMode: "floor" },
      { kind: "system" },
      null,
    );
    expect(r.ok).toBe(true);
    expect((await systemQuery("settings.get", {})).company.registrationNumber).toBeNull();
  });

  it("税率を適用開始日つきで追加でき、同じ日の重複と不正な数字はエラー", async () => {
    const admin = await createEmployee(["admin"]);
    const res = await as(admin).hx("/admin/settings/tax-rates", {
      category: "standard",
      ratePercent: "12",
      effectiveFrom: "2099-04-01",
      _key: newKey(),
    });
    expect(res.headers.get("HX-Redirect")).toBe("/admin/settings?notice=taxRateAdded");
    const settings = await systemQuery("settings.get", {});
    const added = settings.taxRates.find((r) => r.effectiveFrom === "2099-04-01");
    expect(added?.rateBps).toBe(1200);
    // 未来の税率はまだ適用されない
    expect(settings.activeTaxRateIds).not.toContain(added?.id);
    expect(settings.activeTaxRateIds).toContain("tax-standard-2019");
    const dup = await as(admin).hx("/admin/settings/tax-rates", {
      category: "standard",
      ratePercent: "12",
      effectiveFrom: "2099-04-01",
      _key: newKey(),
    });
    expect(await dup.text()).toContain("同じ税区分・適用開始日の税率がすでにあります");
    const bad = await as(admin).hx("/admin/settings/tax-rates", {
      category: "reduced",
      ratePercent: "abc",
      effectiveFrom: "",
      _key: newKey(),
    });
    const html = await bad.text();
    expect(html).toContain("税率は数字で入力してください");
    expect(html).toContain("日付を正しく入力してください");
    const page = await (await as(admin).get("/admin/settings?notice=taxRateAdded")).text();
    expect(page).toContain("税率を追加しました");
    expect(page).toContain("12%");
  });
});
