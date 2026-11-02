/** 自社情報・税率表・端数処理（要件定義書 3.1）。 */
import { z } from "zod";

import { err, ok } from "../../domain/result";
import { normalizeRegistrationNumber } from "../../domain/validation";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE } from "../core";
import { businessDate, optionalText, requiredText, version } from "../schemas";
import { emailInput, faxInput, phoneInput, postalCodeInput } from "./contact";
import type { TaxRateRecord } from "./settings.port";

export const updateCompanySettings = defineCommand({
  permission: "settings.manage",
  input: z.object({
    version,
    name: requiredText(100),
    registrationNumber: z
      .string()
      .optional()
      .nullable()
      .transform((value, ctx) => {
        const t = (value ?? "").trim();
        if (t === "") return null;
        const n = normalizeRegistrationNumber(t);
        if (!n) {
          ctx.addIssue({ code: "custom", message: "登録番号は T と13桁の数字で入力してください" });
          return z.NEVER;
        }
        return n;
      }),
    postalCode: postalCodeInput,
    address: optionalText(200),
    phone: phoneInput,
    fax: faxInput,
    email: emailInput,
    bankInfo: optionalText(500),
    roundingMode: z.enum(["floor", "round", "ceil"]),
  }),
  run(ctx, { version: v, ...patch }) {
    const before = ctx.stores.settings.getCompany();
    if (
      !ctx.stores.settings.updateCompany(v, patch, {
        at: ctx.clock.now().toISOString(),
        by: ctx.actor.employeeId,
      })
    ) {
      return err("conflict", STALE_VERSION_MESSAGE);
    }
    ctx.audit.record({
      entityType: "company_settings",
      entityId: "main",
      action: "update",
      before,
      after: patch,
    });
    return ok({});
  },
});

export const addTaxRate = defineCommand({
  permission: "settings.manage",
  input: z.object({
    category: z.enum(["standard", "reduced"]),
    ratePercent: z.number().min(0, "0以上で入力してください").max(100, "100以下で入力してください"),
    effectiveFrom: businessDate,
  }),
  run(ctx, input) {
    const rateBps = Math.round(input.ratePercent * 100);
    if (ctx.stores.settings.hasTaxRate(input.category, input.effectiveFrom)) {
      return err("duplicate", "同じ税区分・適用開始日の税率がすでにあります");
    }
    const id = ctx.ids.next();
    ctx.stores.settings.addTaxRate(id, input.category, rateBps, input.effectiveFrom, {
      at: ctx.clock.now().toISOString(),
      by: ctx.actor.employeeId,
    });
    ctx.audit.record({
      entityType: "tax_rate",
      entityId: id,
      action: "create",
      after: { ...input, rateBps },
    });
    return ok({ id });
  },
});

export const getSettings = defineQuery({
  permission: "view",
  input: z.object({}),
  run(ctx) {
    const taxRates = ctx.stores.settings.listTaxRates();
    const today = ctx.clock.today();
    // 税区分ごとに、今日の時点で適用されている税率（適用開始日が今日以前で最も新しいもの）
    const activeTaxRateIds = (["standard", "reduced"] as const).flatMap((category) => {
      const current = taxRates
        .filter((r) => r.category === category && r.effectiveFrom <= today)
        .reduce<TaxRateRecord | undefined>(
          (best, r) => (!best || r.effectiveFrom > best.effectiveFrom ? r : best),
          undefined,
        );
      return current ? [current.id] : [];
    });
    return { company: ctx.stores.settings.getCompany(), taxRates, activeTaxRateIds };
  },
});
