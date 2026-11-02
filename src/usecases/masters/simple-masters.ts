/**
 * 名前と表示順だけのマスタ（ジャンル・払い出し先店舗：要件定義書 3.3）。
 * 取引で使われたマスタは削除せず「取引終了」にするので、削除の操作は持たない。
 */
import { z } from "zod";

import { err, ok } from "../../domain/result";
import type { Permission } from "../../domain/roles";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE } from "../core";
import type { Stores } from "../ports";
import { idSchema, requiredText, version } from "../schemas";
import type { MasterOption, SimpleMasterRecord, SimpleMasterStore } from "./simple-masters.port";

export const displayOrderInput = z
  .number({ error: "表示順は数字で入力してください" })
  .int("表示順は整数で入力してください")
  .min(0, "0以上で入力してください")
  .max(9999, "9999以下で入力してください")
  .default(0);

const fieldsInput = z.object({ name: requiredText(50), displayOrder: displayOrderInput });

interface SimpleMasterSpec {
  /** 操作履歴の entity_type */
  readonly entityType: string;
  /** 画面に出す名前（「ジャンル」など） */
  readonly label: string;
  readonly permission: Permission;
  readonly store: (stores: Stores) => SimpleMasterStore;
}

function duplicateName(label: string) {
  return err("duplicate", `同じ名前の${label}がすでにあります`, {
    fields: [{ field: "name", message: "すでに登録されています" }],
  });
}

export function simpleMasterUsecases(spec: SimpleMasterSpec) {
  const create = defineCommand({
    permission: spec.permission,
    input: fieldsInput,
    run(ctx, input) {
      const store = spec.store(ctx.stores);
      if (store.findByName(input.name)) return duplicateName(spec.label);
      const id = ctx.ids.next();
      store.insert(id, input, { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId });
      ctx.audit.record({
        entityType: spec.entityType,
        entityId: id,
        action: "create",
        after: input,
      });
      return ok({ id });
    },
  });

  const update = defineCommand({
    permission: spec.permission,
    input: z.object({ id: idSchema, version, fields: fieldsInput }),
    run(ctx, { id, version: v, fields }) {
      const store = spec.store(ctx.stores);
      const before = store.get(id);
      if (!before) return err("not_found", `${spec.label}が見つかりません`);
      const same = store.findByName(fields.name);
      if (same && same.id !== id) return duplicateName(spec.label);
      if (
        !store.update(id, v, fields, {
          at: ctx.clock.now().toISOString(),
          by: ctx.actor.employeeId,
        })
      )
        return err("conflict", STALE_VERSION_MESSAGE);
      ctx.audit.record({
        entityType: spec.entityType,
        entityId: id,
        action: "update",
        before,
        after: fields,
      });
      return ok({ id });
    },
  });

  const archive = defineCommand({
    permission: spec.permission,
    input: z.object({ id: idSchema, version, archived: z.boolean() }),
    run(ctx, { id, version: v, archived }) {
      const store = spec.store(ctx.stores);
      if (!store.get(id)) return err("not_found", `${spec.label}が見つかりません`);
      if (
        !store.update(
          id,
          v,
          { archived },
          { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId },
        )
      )
        return err("conflict", STALE_VERSION_MESSAGE);
      ctx.audit.record({
        entityType: spec.entityType,
        entityId: id,
        action: archived ? "archive" : "unarchive",
      });
      return ok({ id });
    },
  });

  const list = defineQuery({
    permission: "view",
    input: z.object({ includeArchived: z.boolean().default(false) }),
    run(ctx, { includeArchived }): SimpleMasterRecord[] {
      return spec.store(ctx.stores).list(includeArchived);
    },
  });

  const get = defineQuery({
    permission: "view",
    input: z.object({ id: idSchema }),
    run(ctx, { id }): SimpleMasterRecord | null {
      return spec.store(ctx.stores).get(id) ?? null;
    },
  });

  /** 選択肢（取引終了を除く、表示順） */
  const options = defineQuery({
    permission: "view",
    input: z.object({}),
    run(ctx): MasterOption[] {
      return spec.store(ctx.stores).options();
    },
  });

  return { create, update, archive, list, get, options };
}

/** ジャンル。権限表では商品マスタと同じ扱い（仕入・管理者） */
export const genreUsecases = simpleMasterUsecases({
  entityType: "genre",
  label: "ジャンル",
  permission: "items.manage",
  store: (s) => s.genres,
});

/** 払い出し先店舗。権限表では保管場所と同じ扱い（管理者） */
export const retailStoreUsecases = simpleMasterUsecases({
  entityType: "retail_store",
  label: "払い出し先店舗",
  permission: "locations.manage",
  store: (s) => s.retailStores,
});
