/**
 * 受注の明細の評価（金額・出荷可能数・警告）。受注の作成・編集の画面（変わった行と合計の再計算）と、
 * 受注詳細の表示で使う。金額と警告の判定は domain の関数で行う。
 */
import { ratesOn, type TaxCategory, type TaxSummary } from "../../domain/money";
import {
  availableForOrder,
  isPriceOverridden,
  orderAmounts,
  priceReasonRequired,
  salesLineWarnings,
} from "../../domain/sales";
import type { QueryContext } from "../core";
import { stockLevels } from "../stock/ledger";
import type { SalesOrderDetail } from "./orders.port";

/** 画面で入力中の明細。数量・単価が正しく入力されていなければ null */
export interface DraftLine {
  readonly itemId: string;
  readonly quantity: number | null;
  readonly unitPriceCenti: number | null;
  readonly priceOverrideReason: string | null;
}

export interface DraftCharge {
  readonly description: string;
  readonly quantity: number | null;
  readonly unitAmount: number | null;
  readonly taxCategory: TaxCategory;
}

export interface EvaluatedLine {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly salesUnitName: string;
  readonly salesMinLot: number;
  /** 今の卸単価（商品マスタ） */
  readonly listPriceCenti: number;
  readonly discontinued: boolean;
  /** 明細の税区分（保存済みの明細は受注時点の写し、新しい明細は商品の税区分） */
  readonly taxCategory: TaxCategory;
  readonly quantity: number | null;
  readonly unitPriceCenti: number | null;
  readonly priceOverrideReason: string | null;
  /** 金額（税抜・円）。数量か単価が未入力なら null */
  readonly amount: number | null;
  /** 保管場所の現在庫（メーカー直・保管場所が未選択なら null） */
  readonly onHand: number | null;
  /** この受注の分を除いた出荷可能数（メーカー直・保管場所が未選択なら null） */
  readonly available: number | null;
  readonly warnings: readonly string[];
  /** 卸単価と違う単価か */
  readonly priceOverridden: boolean;
  /** 単価を修正した理由が必要なのに入力されていない */
  readonly reasonMissing: boolean;
}

export interface OrderEvaluation {
  readonly lines: readonly EvaluatedLine[];
  /** 送料などの金額（数量か単価が未入力なら null） */
  readonly chargeAmounts: readonly (number | null)[];
  /** 税率ごとの合計。未入力の明細は含めない。取引日の税率がなければ null */
  readonly summary: TaxSummary | null;
  /** 未入力の明細・送料がある（合計に含めていない） */
  readonly incomplete: boolean;
}

export interface EvaluateInput {
  /** 編集中の受注（保存済みの単価・税区分と、自分の引当を知るため）。新規なら undefined */
  readonly existing: SalesOrderDetail | undefined;
  /** 税率を決める日（受注日） */
  readonly date: string;
  readonly makerDirect: boolean;
  readonly locationId: string | null;
  readonly lines: readonly DraftLine[];
  readonly charges: readonly DraftCharge[];
  /** 出荷可能数と警告を出すか（発送前の受注だけ） */
  readonly withStock: boolean;
}

const NO_RATES = { standard: 0, reduced: 0 } as const;

function valid(n: number | null): n is number {
  return n !== null && Number.isSafeInteger(n);
}

export function evaluateOrder(
  ctx: Pick<QueryContext, "stores">,
  input: EvaluateInput,
): OrderEvaluation {
  const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
  const items = new Map(ctx.stores.items.getMany(itemIds).map((i) => [i.id, i]));
  const saved = new Map((input.existing?.lines ?? []).map((l) => [l.itemId, l]));
  const ownAllocation = new Map<string, number>();
  const existing = input.existing;
  if (
    existing &&
    existing.status === "received" &&
    !existing.makerDirect &&
    existing.locationId !== null &&
    existing.locationId === input.locationId
  ) {
    for (const l of existing.lines)
      ownAllocation.set(l.itemId, (ownAllocation.get(l.itemId) ?? 0) + l.quantity);
  }
  const levels =
    input.withStock && !input.makerDirect && input.locationId
      ? stockLevels(ctx, itemIds, input.locationId)
      : null;

  const company = ctx.stores.settings.getCompany();
  const rates = ratesOn(ctx.stores.settings.listTaxRates(), input.date);

  const draft = input.lines.flatMap((line) => {
    const item = items.get(line.itemId);
    if (!item) return [];
    const savedLine = saved.get(line.itemId);
    return [{ line, item, taxCategory: savedLine?.taxCategory ?? item.taxCategory, savedLine }];
  });

  // 金額は数量・単価がそろった明細だけで計算する（index は draft・input.charges の位置）
  const priced = draft.flatMap((d, index) => {
    const { quantity, unitPriceCenti } = d.line;
    return valid(quantity) && valid(unitPriceCenti)
      ? [{ index, quantity, unitPriceCenti, taxCategory: d.taxCategory }]
      : [];
  });
  const charges = input.charges.flatMap((c, index) =>
    valid(c.quantity) && valid(c.unitAmount)
      ? [{ index, quantity: c.quantity, unitAmount: c.unitAmount, taxCategory: c.taxCategory }]
      : [],
  );
  // 税率がなければ合計は出さない（summary を null にする）。明細の金額は税率によらない
  const amounts = orderAmounts(priced, charges, rates ?? NO_RATES, company.roundingMode);
  const lineAmount = new Map(amounts.lines.map((l) => [l.index, l.amount]));
  const chargeAmount = new Map(amounts.charges.map((c) => [c.index, c.amount]));

  const lines = draft.map((d, i): EvaluatedLine => {
    const { line, item } = d;
    const level = levels?.get(item.id);
    const avail = level
      ? availableForOrder(level.available, ownAllocation.get(item.id) ?? 0)
      : null;
    const price = valid(line.unitPriceCenti) ? line.unitPriceCenti : null;
    return {
      itemId: item.id,
      itemCode: item.code,
      itemName: item.name,
      salesUnitName: item.salesUnitName,
      salesMinLot: item.salesMinLot,
      listPriceCenti: item.salesPriceCenti,
      discontinued: item.discontinued,
      taxCategory: d.taxCategory,
      quantity: line.quantity,
      unitPriceCenti: line.unitPriceCenti,
      priceOverrideReason: line.priceOverrideReason,
      amount: lineAmount.get(i) ?? null,
      onHand: level ? level.onHand : null,
      available: avail,
      warnings:
        input.withStock && valid(line.quantity)
          ? salesLineWarnings({
              quantity: line.quantity,
              minLot: item.salesMinLot,
              availableForOrder: avail,
            })
          : [],
      priceOverridden: price !== null && isPriceOverridden(price, item.salesPriceCenti),
      reasonMissing:
        price !== null &&
        priceReasonRequired({
          unitPriceCenti: price,
          listPriceCenti: item.salesPriceCenti,
          previousPriceCenti: d.savedLine?.unitPriceCenti ?? null,
          reason: line.priceOverrideReason,
        }),
    };
  });

  return {
    lines,
    chargeAmounts: input.charges.map((_, i) => chargeAmount.get(i) ?? null),
    summary: rates ? amounts.summary : null,
    incomplete: priced.length < draft.length || charges.length < input.charges.length,
  };
}
