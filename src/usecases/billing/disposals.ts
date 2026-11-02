/**
 * 販売先廃棄（要件定義書 3.12）。記録と分析のためだけに使い、請求・入金・自社の在庫には影響させない。
 * 廃棄伝票で、1つの販売先・廃棄日に対して複数の商品を登録する。廃棄理由（賞味期限切れ・破損・その他）は任意。
 * 集計では、期間・販売先・商品ごとに廃棄数と出荷数に対する廃棄率を出す（取り消した伝票は含めない）。
 * 誤って登録した伝票は、理由を入力して取り消す（一覧には取消の印をつけて残す）。
 */
import { z } from "zod";

import {
  cancelDisposal,
  summarizeDisposalRates,
  validateDisposalLines,
} from "../../domain/billing";
import { err, ok } from "../../domain/result";
import { defineCommand, defineQuery, STALE_VERSION_MESSAGE } from "../core";
import {
  businessDate,
  idSchema,
  optionalBusinessDate,
  optionalText,
  pageInput,
  requiredText,
  version,
  type Page,
} from "../schemas";
import type {
  DisposalListRow,
  DisposalRateSource,
  DisposalRecord,
  ShippedItem,
} from "./disposals.port";

const reasonInput = z.enum(["expired", "damaged", "other"]).nullable().default(null);

export const createDisposal = defineCommand({
  permission: "disposals.manage",
  input: z.object({
    customerId: z.string().min(1, "販売先を選んでください").max(64),
    disposedOn: businessDate,
    contactName: optionalText(100),
    memo: optionalText(1000),
    lines: z
      .array(
        z.object({
          itemId: idSchema,
          quantity: z
            .number({ error: "数量は数字で入力してください" })
            .int("整数で入力してください"),
          reason: reasonInput,
        }),
      )
      .max(300, "1つの廃棄伝票に入れられる商品は300件までです"),
  }),
  run(ctx, input) {
    const customer = ctx.stores.partners.get(input.customerId);
    if (!customer || !customer.isCustomer) {
      const message = "販売先を選んでください";
      return err("validation", message, { fields: [{ field: "customerId", message }] });
    }
    if (input.disposedOn > ctx.clock.today()) {
      const message = "今日より後の日付は入力できません";
      return err("validation", message, { fields: [{ field: "disposedOn", message }] });
    }
    const checked = validateDisposalLines(input.lines);
    if (!checked.ok) return checked;
    const items = new Set(
      ctx.stores.items.getMany(input.lines.map((l) => l.itemId)).map((i) => i.id),
    );
    for (const [i, l] of input.lines.entries()) {
      if (!items.has(l.itemId)) {
        const message = "登録されていない商品が含まれています";
        return err("validation", message, { fields: [{ field: `lines.${i}.itemId`, message }] });
      }
    }
    const id = ctx.ids.next();
    const number = ctx.sequences.next("disposal", input.disposedOn);
    const lines = input.lines.map((l) => ({ id: ctx.ids.next(), ...l }));
    ctx.stores.disposals.insert(
      {
        id,
        number,
        customerId: customer.id,
        disposedOn: input.disposedOn,
        contactName: input.contactName,
        memo: input.memo,
      },
      lines,
      { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId },
    );
    ctx.audit.record({
      entityType: "disposal",
      entityId: id,
      action: "create",
      after: { number, customerId: customer.id, disposedOn: input.disposedOn, lines },
    });
    return ok({ id, number });
  },
});

/**
 * 廃棄伝票の取消（domain の cancelDisposal）。理由が必須。在庫・請求・入金には何もしない。
 * 取り消した伝票は一覧に残り（取消の印と理由）、廃棄率の集計から外れる
 */
export const cancelDisposalCommand = defineCommand({
  permission: "disposals.manage",
  input: z.object({ id: idSchema, version, reason: requiredText(500) }),
  run(ctx, { id, version: v, reason }) {
    const disposal = ctx.stores.disposals.get(id);
    if (!disposal) return err("not_found", "廃棄伝票が見つかりません");
    const next = cancelDisposal(disposal, reason);
    if (!next.ok) return next;
    const meta = { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId };
    if (!ctx.stores.disposals.markCancelled(id, v, reason, meta))
      return err("conflict", STALE_VERSION_MESSAGE);
    ctx.audit.record({
      entityType: "disposal",
      entityId: id,
      action: "cancel",
      before: { cancelled: false },
      after: { cancelled: true, reason },
    });
    return ok({ id, number: disposal.number });
  },
});

/** 廃棄伝票の一覧（廃棄日の新しい順）。取り消した伝票も含める（cancelled で絞り込める） */
export const listDisposals = defineQuery({
  permission: "view",
  input: pageInput.extend({
    customerId: z.string().max(64).optional(),
    from: optionalBusinessDate,
    to: optionalBusinessDate,
    cancelled: z.enum(["exclude", "only"]).optional(),
  }),
  run(ctx, { customerId, from, to, cancelled, page, pageSize }): Page<DisposalListRow> {
    return ctx.stores.disposals.list(
      {
        customerId: customerId || undefined,
        from: from ?? undefined,
        to: to ?? undefined,
        cancelled,
      },
      page,
      pageSize,
    );
  },
});

export const getDisposal = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): DisposalRecord | null {
    return ctx.stores.disposals.get(id) ?? null;
  },
});

/** 販売先に出荷したことのある商品（廃棄伝票の商品の候補。最後に出荷した日の新しい順） */
export const shippedItemsForCustomer = defineQuery({
  permission: "view",
  input: z.object({ customerId: idSchema }),
  run(ctx, { customerId }): ShippedItem[] {
    return ctx.stores.disposals.shippedItems(customerId, 200);
  },
});

export interface DisposalRateItem {
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly itemId: string | null;
  readonly itemCode: string | null;
  readonly itemName: string | null;
  readonly unitName: string | null;
  readonly disposed: number;
  readonly shipped: number;
  /** 廃棄率（ベーシスポイント、1% = 100）。出荷がなければ null */
  readonly rateBps: number | null;
}

const GROUP_KEYS: Readonly<
  Record<"customer_item" | "customer" | "item", (r: DisposalRateSource) => string>
> = {
  customer_item: (r) => `${r.customerId}\u0000${r.itemId}`,
  customer: (r) => r.customerId,
  item: (r) => r.itemId,
};

/**
 * 廃棄率の集計：期間内の廃棄数（取り消していない廃棄伝票）と出荷数（取り消していない発送）を、
 * 販売先 × 商品・販売先・商品のどれかで合計する。
 * onlyDisposed なら廃棄のあるものだけ。並びは販売先の読み仮名・商品コードの順
 */
export const disposalRates = defineQuery({
  permission: "view",
  input: pageInput.extend({
    from: businessDate,
    to: businessDate,
    customerId: z.string().max(64).optional(),
    itemId: z.string().max(64).optional(),
    groupBy: z.enum(["customer_item", "customer", "item"]).default("customer_item"),
    onlyDisposed: z.boolean().default(true),
  }),
  run(ctx, input): Page<DisposalRateItem> {
    const sources = ctx.stores.disposals.rateSources({
      from: input.from,
      to: input.to,
      customerId: input.customerId || undefined,
      itemId: input.itemId || undefined,
    });
    const ordered =
      input.groupBy === "item"
        ? sources.toSorted((a, b) => a.itemCode.localeCompare(b.itemCode))
        : sources;
    const groups = summarizeDisposalRates(ordered, GROUP_KEYS[input.groupBy])
      .filter((g) => !input.onlyDisposed || g.disposed > 0)
      .map((g): DisposalRateItem => ({
        customerId: input.groupBy === "item" ? null : g.row.customerId,
        customerName: input.groupBy === "item" ? null : g.row.customerName,
        itemId: input.groupBy === "customer" ? null : g.row.itemId,
        itemCode: input.groupBy === "customer" ? null : g.row.itemCode,
        itemName: input.groupBy === "customer" ? null : g.row.itemName,
        unitName: input.groupBy === "customer" ? null : g.row.unitName,
        disposed: g.disposed,
        shipped: g.shipped,
        rateBps: g.rateBps,
      }));
    const start = (input.page - 1) * input.pageSize;
    return {
      rows: groups.slice(start, start + input.pageSize),
      total: groups.length,
      page: input.page,
      pageSize: input.pageSize,
    };
  },
});
