/**
 * 社員と自社設定のユースケース（要件定義書 2章・3.1）の業務エラー・権限・二重送信。
 * 画面のルートは管理の区分で追加する。ここではユースケースの決まりを確かめる。
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Result } from "../../src/domain/result";
import { businessDb } from "../../src/infra/do/client";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import { unwrap, unwrapErr } from "../support/result";
import { ADMIN_EMAIL, createEmployee, systemCommand, systemQuery } from "./helpers";

function commandAs<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string | null = null,
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

async function employeeByEmail(email: string) {
  const all = await systemQuery("employees.list", {});
  const found = all.find((e) => e.email === email);
  if (!found) throw new Error(`employee not found: ${email}`);
  return found;
}

describe("社員", () => {
  it("同じメールアドレスは登録できない。管理者以外は登録できない", async () => {
    const email = await createEmployee(["sales"]);
    const dup = unwrapErr(
      await commandAs(ADMIN_EMAIL, "employees.create", { email, name: "重複", roles: ["sales"] }),
    );
    expect(dup.code).toBe("duplicate");
    const denied = unwrapErr(
      await commandAs(email, "employees.create", {
        email: "new@example.co.jp",
        name: "新人",
        roles: ["sales"],
      }),
    );
    expect(denied.code).toBe("forbidden");
  });

  it("有効な管理者が1人もいなくなる変更はできない", async () => {
    const admin = await employeeByEmail(ADMIN_EMAIL);
    const lose = unwrapErr(
      await commandAs(ADMIN_EMAIL, "employees.update", {
        id: admin.id,
        version: admin.version,
        name: admin.name,
        roles: ["sales"],
        active: true,
      }),
    );
    expect(lose.message).toContain("有効な管理者が1人もいなくなる");
    const deactivate = unwrapErr(
      await commandAs(ADMIN_EMAIL, "employees.update", {
        id: admin.id,
        version: admin.version,
        name: admin.name,
        roles: ["admin"],
        active: false,
      }),
    );
    expect(deactivate.code).toBe("invalid_state");

    // ほかに管理者がいれば、役割を外せる
    const second = await createEmployee(["admin"], "二人目の管理者");
    const secondRecord = await employeeByEmail(second);
    unwrap(
      await commandAs(second, "employees.update", {
        id: admin.id,
        version: admin.version,
        name: admin.name,
        roles: ["admin", "accounting"],
        active: true,
      }),
    );
    const updated = await employeeByEmail(ADMIN_EMAIL);
    expect(updated.roles).toEqual(["admin", "accounting"]);
    unwrap(
      await commandAs(ADMIN_EMAIL, "employees.update", {
        id: secondRecord.id,
        version: secondRecord.version,
        name: secondRecord.name,
        roles: ["sales"],
        active: false,
      }),
    );
    expect((await employeeByEmail(second)).active).toBe(false);
  });

  it("存在しない社員・古い版番号の更新はエラーにする", async () => {
    const missing = unwrapErr(
      await commandAs(ADMIN_EMAIL, "employees.update", {
        id: "missing",
        version: 1,
        name: "x",
        roles: ["sales"],
        active: true,
      }),
    );
    expect(missing.code).toBe("not_found");
    const email = await createEmployee(["purchasing"]);
    const e = await employeeByEmail(email);
    unwrap(
      await commandAs(ADMIN_EMAIL, "employees.update", {
        id: e.id,
        version: e.version,
        name: "改名",
        roles: ["purchasing"],
        active: true,
      }),
    );
    const stale = unwrapErr(
      await commandAs(ADMIN_EMAIL, "employees.update", {
        id: e.id,
        version: e.version,
        name: "改名2",
        roles: ["purchasing"],
        active: true,
      }),
    );
    expect(stale.code).toBe("conflict");
    expect((await systemQuery("employees.get", { id: e.id }))?.name).toBe("改名");
    expect(await systemQuery("employees.get", { id: "missing" })).toBeNull();
  });
});

describe("自社設定と税率表", () => {
  it("登録番号は T と13桁で検証し、空なら未設定にする。古い版番号の保存はエラー", async () => {
    const { company } = await systemQuery("settings.get", {});
    const base = {
      version: company.version,
      name: "株式会社テスト商事",
      postalCode: "022-0002",
      address: "岩手県大船渡市",
      phone: "0192-00-0000",
      fax: null,
      email: "office@example.co.jp",
      bankInfo: null,
      roundingMode: "floor" as const,
    };
    const invalid = unwrapErr(
      await commandAs(ADMIN_EMAIL, "settings.updateCompany", {
        ...base,
        registrationNumber: "T123",
      }),
    );
    expect(invalid.fields?.[0]?.message).toBe("登録番号は T と13桁の数字で入力してください");
    unwrap(
      await commandAs(ADMIN_EMAIL, "settings.updateCompany", {
        ...base,
        registrationNumber: " t1234567890123 ",
      }),
    );
    const saved = (await systemQuery("settings.get", {})).company;
    expect(saved.registrationNumber).toBe("T1234567890123");
    unwrap(
      await commandAs(ADMIN_EMAIL, "settings.updateCompany", {
        ...base,
        version: saved.version,
        registrationNumber: "",
      }),
    );
    expect((await systemQuery("settings.get", {})).company.registrationNumber).toBeNull();
    const stale = unwrapErr(
      await commandAs(ADMIN_EMAIL, "settings.updateCompany", { ...base, registrationNumber: null }),
    );
    expect(stale.code).toBe("conflict");
  });

  it("管理者以外は自社設定を変えられない", async () => {
    const email = await createEmployee(["accounting"]);
    const { company } = await systemQuery("settings.get", {});
    const denied = unwrapErr(
      await commandAs(email, "settings.updateCompany", {
        version: company.version,
        name: "x",
        roundingMode: "floor",
      }),
    );
    expect(denied.code).toBe("forbidden");
  });

  it("税率を追加でき、同じ税区分・適用開始日は重ねて登録できない", async () => {
    await systemCommand("settings.addTaxRate", {
      category: "standard",
      ratePercent: 12.5,
      effectiveFrom: "2030-04-01",
    });
    const { taxRates } = await systemQuery("settings.get", {});
    expect(taxRates).toContainEqual(
      expect.objectContaining({ category: "standard", rateBps: 1250, effectiveFrom: "2030-04-01" }),
    );
    const dup = unwrapErr(
      await commandAs(ADMIN_EMAIL, "settings.addTaxRate", {
        category: "standard",
        ratePercent: 10,
        effectiveFrom: "2030-04-01",
      }),
    );
    expect(dup.code).toBe("duplicate");
  });
});
