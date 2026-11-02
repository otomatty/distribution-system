/** 保管場所（要件定義書 3.3）。在庫を置く場所で、連絡先一式を持つ。権限表では管理者だけが編集できる */
import { z } from "zod";

import { err, ok } from "../../domain/result";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE } from "../core";
import { idSchema, optionalText, requiredText, version } from "../schemas";
import { contactInput } from "./contact";
import type { LocationRecord } from "./locations.port";
import { displayOrderInput } from "./simple-masters";
import type { MasterOption } from "./simple-masters.port";

const fieldsInput = z.object({
  name: requiredText(50),
  ...contactInput,
  memo: optionalText(2000),
  displayOrder: displayOrderInput,
});

const DUPLICATE = err("duplicate", "同じ名前の保管場所がすでにあります", {
  fields: [{ field: "name", message: "すでに登録されています" }],
});

export const createLocation = defineCommand({
  permission: "locations.manage",
  input: fieldsInput,
  run(ctx, input) {
    if (ctx.stores.locations.findByName(input.name)) return DUPLICATE;
    const id = ctx.ids.next();
    ctx.stores.locations.insert(id, input, {
      at: ctx.clock.now().toISOString(),
      by: ctx.actor.employeeId,
    });
    ctx.audit.record({ entityType: "location", entityId: id, action: "create", after: input });
    return ok({ id });
  },
});

export const updateLocation = defineCommand({
  permission: "locations.manage",
  input: z.object({ id: idSchema, version, fields: fieldsInput }),
  run(ctx, { id, version: v, fields }) {
    const before = ctx.stores.locations.get(id);
    if (!before) return err("not_found", "保管場所が見つかりません");
    const same = ctx.stores.locations.findByName(fields.name);
    if (same && same.id !== id) return DUPLICATE;
    const updated = ctx.stores.locations.update(id, v, fields, {
      at: ctx.clock.now().toISOString(),
      by: ctx.actor.employeeId,
    });
    if (!updated) return err("conflict", STALE_VERSION_MESSAGE);
    ctx.audit.record({
      entityType: "location",
      entityId: id,
      action: "update",
      before,
      after: fields,
    });
    return ok({ id });
  },
});

export const archiveLocation = defineCommand({
  permission: "locations.manage",
  input: z.object({ id: idSchema, version, archived: z.boolean() }),
  run(ctx, { id, version: v, archived }) {
    if (!ctx.stores.locations.get(id)) return err("not_found", "保管場所が見つかりません");
    const updated = ctx.stores.locations.update(
      id,
      v,
      { archived },
      { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId },
    );
    if (!updated) return err("conflict", STALE_VERSION_MESSAGE);
    ctx.audit.record({
      entityType: "location",
      entityId: id,
      action: archived ? "archive" : "unarchive",
    });
    return ok({ id });
  },
});

export const listLocations = defineQuery({
  permission: "view",
  input: z.object({ includeArchived: z.boolean().default(false) }),
  run(ctx, { includeArchived }): LocationRecord[] {
    return ctx.stores.locations.list(includeArchived);
  },
});

export const getLocation = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): LocationRecord | null {
    return ctx.stores.locations.get(id) ?? null;
  },
});

/** 選択肢（取引終了を除く、表示順）。発注の納入先・受注の出荷元・在庫操作で使う */
export const locationOptions = defineQuery({
  permission: "view",
  input: z.object({}),
  run(ctx): MasterOption[] {
    return ctx.stores.locations.options();
  },
});
