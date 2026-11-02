/**
 * 取引条件の検証：当月払いで支払日が締め日より前になる条件（例：20日締め・当月10日払い）は、
 * 支払期限が締め期間の終わりより前になり締め処理ができないため、保存のときに拒否する。
 */
import { describe, expect, it } from "vitest";

import { createSupplier } from "./fixtures";
import { as, createEmployee, newKey, systemQuery } from "./helpers";
import { systemCommandResult } from "./platform-helpers";

function termsForm(version: number, closingDay: string, offset: string, paymentDay: string) {
  return {
    _key: newKey(),
    version: String(version),
    registrationNumber: "",
    closingDay,
    paymentMonthOffset: offset,
    paymentDay,
  };
}

describe("取引条件の検証（締め処理ができない条件）", () => {
  it("当月払いで支払日が締め日より前なら、支払日の欄にエラーを出して保存しない", async () => {
    const user = await createEmployee(["accounting"]);
    const id = await createSupplier();
    const res = await as(user).hx(`/partners/${id}/terms`, termsForm(1, "20", "0", "10"));
    const html = await res.text();
    expect(html).toContain("当月払いの支払日は締め日（20日）以降にしてください");
    expect(html).toMatch(/id="f-paymentDay"[^>]*aria-invalid="true"/);
    // 月末締め（31）・当月28日払いも、月末より前に支払日が来るので拒否する
    const monthEnd = await systemCommandResult("partners.updateTerms", {
      id,
      version: 1,
      terms: { closingDay: 31, paymentMonthOffset: 0, paymentDay: 28 },
    });
    expect(monthEnd).toMatchObject({
      ok: false,
      error: { code: "validation", fields: [{ field: "terms.paymentDay" }] },
    });
    expect((await systemQuery("partners.get", { id }))?.closingDay).toBeNull();
  });

  it("当月払いで支払日が締め日と同じか後、または翌月以降の払いなら保存できる", async () => {
    const user = await createEmployee(["accounting"]);
    const id = await createSupplier();
    const same = await as(user).hx(`/partners/${id}/terms`, termsForm(1, "20", "0", "20"));
    expect(same.status).toBe(204);
    const monthEnd = await as(user).hx(`/partners/${id}/terms`, termsForm(2, "20", "0", "31"));
    expect(monthEnd.status).toBe(204);
    const nextMonth = await as(user).hx(`/partners/${id}/terms`, termsForm(3, "20", "1", "10"));
    expect(nextMonth.status).toBe(204);
    const saved = await systemQuery("partners.get", { id });
    expect(saved).toMatchObject({ closingDay: 20, paymentMonthOffset: 1, paymentDay: 10 });
  });
});
