/** 社員の登録・役割・有効無効（要件定義書 2章）。ログイン自体は Better Auth が行う。 */
import { z } from "zod";

import { err, ok } from "../../domain/result";
import { ROLES } from "../../domain/roles";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE } from "../core";
import { idSchema, requiredText, version } from "../schemas";
import type { EmployeeStore } from "./employees.port";

const rolesInput = z.array(z.enum(ROLES)).min(1, "役割を1つ以上選んでください");

function activeAdminCount(store: EmployeeStore, excludeId?: string): number {
  return store.list().filter((e) => e.active && e.roles.includes("admin") && e.id !== excludeId)
    .length;
}

export const createEmployee = defineCommand({
  permission: "employees.manage",
  input: z.object({
    email: z
      .email("メールアドレスの形式が正しくありません")
      .transform((v) => v.trim().toLowerCase()),
    name: requiredText(100),
    roles: rolesInput,
  }),
  run(ctx, input) {
    if (ctx.stores.employees.findByEmail(input.email)) {
      return err("duplicate", "このメールアドレスはすでに登録されています", {
        fields: [{ field: "email", message: "すでに登録されています" }],
      });
    }
    const id = ctx.ids.next();
    ctx.stores.employees.insert(
      {
        id,
        email: input.email,
        name: input.name,
        roles: input.roles,
        active: true,
        authUserId: null,
      },
      { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId },
    );
    ctx.audit.record({ entityType: "employee", entityId: id, action: "create", after: input });
    return ok({ id });
  },
});

export const updateEmployee = defineCommand({
  permission: "employees.manage",
  input: z.object({
    id: idSchema,
    version,
    name: requiredText(100),
    roles: rolesInput,
    active: z.boolean(),
  }),
  run(ctx, input) {
    const before = ctx.stores.employees.get(input.id);
    if (!before) return err("not_found", "社員が見つかりません");
    const losesAdmin =
      before.roles.includes("admin") &&
      before.active &&
      (!input.active || !input.roles.includes("admin"));
    if (losesAdmin && activeAdminCount(ctx.stores.employees, input.id) === 0) {
      return err("invalid_state", "有効な管理者が1人もいなくなるため変更できません");
    }
    const updated = ctx.stores.employees.update(
      input.id,
      input.version,
      { name: input.name, roles: input.roles, active: input.active },
      { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId },
    );
    if (!updated) return err("conflict", STALE_VERSION_MESSAGE);
    ctx.audit.record({
      entityType: "employee",
      entityId: input.id,
      action: "update",
      before,
      after: input,
    });
    return ok({ id: input.id });
  },
});

export const listEmployees = defineQuery({
  permission: "view",
  input: z.object({}),
  run(ctx) {
    return ctx.stores.employees.list();
  },
});

export const getEmployee = defineQuery({
  permission: "employees.manage",
  input: z.object({ id: idSchema }),
  run(ctx, { id }) {
    return ctx.stores.employees.get(id) ?? null;
  },
});
