/** 取引先（要件定義書 3.3）。仕入先と販売先を1つのマスタで扱う。 */
import { z } from "zod";

import { validateClosingTerms } from "../../domain/dates";
import { err, ok } from "../../domain/result";
import { normalizeRegistrationNumber } from "../../domain/validation";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE } from "../core";
import { idSchema, optionalText, pageInput, requiredText, version } from "../schemas";
import { contactInput } from "./contact";
import type { PartnerFields, PartnerRecord } from "./partners.port";

const fieldsInput = z
  .object({
    name: requiredText(100),
    kana: requiredText(100),
    honorific: z.enum(["御中", "様"]).default("御中"),
    isSupplier: z.boolean().default(false),
    isCustomer: z.boolean().default(false),
    ...contactInput,
    deliveryDays: z
      .number()
      .int()
      .min(0, "0以上で入力してください")
      .max(30, "30日以内で入力してください")
      .default(0),
    defaultSendMethod: z.enum(["email", "none"]).default("none"),
    orderMethodNote: optionalText(200),
    receiveMethodNote: optionalText(200),
    mailOrderAllowed: z.boolean().default(false),
    placeName: optionalText(100),
    memo: optionalText(2000),
  })
  .superRefine((v, ctx) => {
    if (!v.isSupplier && !v.isCustomer) {
      ctx.addIssue({
        code: "custom",
        path: ["isSupplier"],
        message: "仕入先・販売先の少なくとも一方を選んでください",
      });
    }
    if (v.defaultSendMethod === "email" && !v.email) {
      ctx.addIssue({
        code: "custom",
        path: ["email"],
        message: "既定の送付方法をメールにする場合はメールアドレスを入力してください",
      });
    }
  });

const termsInput = z.object({
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
  closingDay: z.number().int().nullable().default(null),
  paymentMonthOffset: z.number().int().nullable().default(null),
  paymentDay: z.number().int().nullable().default(null),
});

export const createPartner = defineCommand({
  permission: "partners.manage",
  input: fieldsInput,
  run(ctx, input) {
    const id = ctx.ids.next();
    const fields: PartnerFields = input;
    ctx.stores.partners.insert(
      id,
      {
        ...fields,
        registrationNumber: null,
        closingDay: null,
        paymentMonthOffset: null,
        paymentDay: null,
      },
      { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId },
    );
    ctx.audit.record({ entityType: "partner", entityId: id, action: "create", after: fields });
    return ok({ id });
  },
});

export const updatePartner = defineCommand({
  permission: "partners.manage",
  input: z.object({ id: idSchema, version, fields: fieldsInput }),
  run(ctx, { id, version: v, fields }) {
    const before = ctx.stores.partners.get(id);
    if (!before) return err("not_found", "取引先が見つかりません");
    const updated = ctx.stores.partners.update(id, v, fields, {
      at: ctx.clock.now().toISOString(),
      by: ctx.actor.employeeId,
    });
    if (!updated) return err("conflict", STALE_VERSION_MESSAGE);
    ctx.audit.record({
      entityType: "partner",
      entityId: id,
      action: "update",
      before,
      after: fields,
    });
    return ok({ id });
  },
});

export const updatePartnerTerms = defineCommand({
  permission: "partners.terms",
  input: z.object({ id: idSchema, version, terms: termsInput }),
  run(ctx, { id, version: v, terms }) {
    const before = ctx.stores.partners.get(id);
    if (!before) return err("not_found", "取引先が見つかりません");
    const anyTerm =
      terms.closingDay !== null || terms.paymentMonthOffset !== null || terms.paymentDay !== null;
    if (anyTerm) {
      if (
        terms.closingDay === null ||
        terms.paymentMonthOffset === null ||
        terms.paymentDay === null
      ) {
        return err(
          "validation",
          "締め日・支払月・支払日はすべて入力するか、すべて空にしてください",
          {
            fields: [
              {
                field: "terms.closingDay",
                message: "締め日・支払月・支払日はそろえて入力してください",
              },
            ],
          },
        );
      }
      const message = validateClosingTerms({
        closingDay: terms.closingDay,
        paymentMonthOffset: terms.paymentMonthOffset,
        paymentDay: terms.paymentDay,
      });
      if (message)
        return err("validation", message, { fields: [{ field: "terms.closingDay", message }] });
    }
    const updated = ctx.stores.partners.update(id, v, terms, {
      at: ctx.clock.now().toISOString(),
      by: ctx.actor.employeeId,
    });
    if (!updated) return err("conflict", STALE_VERSION_MESSAGE);
    ctx.audit.record({
      entityType: "partner",
      entityId: id,
      action: "update_terms",
      before: {
        registrationNumber: before.registrationNumber,
        closingDay: before.closingDay,
        paymentMonthOffset: before.paymentMonthOffset,
        paymentDay: before.paymentDay,
      },
      after: terms,
    });
    return ok({ id });
  },
});

export const archivePartner = defineCommand({
  permission: "partners.manage",
  input: z.object({ id: idSchema, version, archived: z.boolean() }),
  run(ctx, { id, version: v, archived }) {
    const before = ctx.stores.partners.get(id);
    if (!before) return err("not_found", "取引先が見つかりません");
    if (
      !ctx.stores.partners.update(
        id,
        v,
        { archived },
        { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId },
      )
    ) {
      return err("conflict", STALE_VERSION_MESSAGE);
    }
    ctx.audit.record({
      entityType: "partner",
      entityId: id,
      action: archived ? "archive" : "unarchive",
    });
    return ok({ id });
  },
});

export const deletePartner = defineCommand({
  permission: "partners.manage",
  input: z.object({ id: idSchema, version }),
  run(ctx, { id, version: v }) {
    const before = ctx.stores.partners.get(id);
    if (!before) return err("not_found", "取引先が見つかりません");
    if (ctx.stores.partners.isReferenced(id)) {
      return err(
        "invalid_state",
        "取引や商品で使われている取引先は削除できません。「取引終了」にしてください",
      );
    }
    if (!ctx.stores.partners.delete(id, v)) return err("conflict", STALE_VERSION_MESSAGE);
    ctx.audit.record({ entityType: "partner", entityId: id, action: "delete", before });
    return ok({ id });
  },
});

export const listPartners = defineQuery({
  permission: "view",
  input: pageInput.extend({
    q: z.string().max(100).optional(),
    role: z.enum(["supplier", "customer"]).optional(),
    includeArchived: z.boolean().default(false),
  }),
  run(ctx, { page, pageSize, ...filter }) {
    return ctx.stores.partners.list(filter, page, pageSize);
  },
});

export const getPartner = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): PartnerRecord | null {
    return ctx.stores.partners.get(id) ?? null;
  },
});

export const partnerOptions = defineQuery({
  permission: "view",
  input: z.object({ role: z.enum(["supplier", "customer"]) }),
  run(ctx, { role }) {
    return ctx.stores.partners.options(role);
  },
});
