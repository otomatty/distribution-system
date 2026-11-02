/** 仕入のユースケースで共通に使うもの */
import type { ClosingTerms } from "../../domain/dates";
import type { TaxCategory } from "../../domain/money";
import { ratesOn } from "../../domain/purchasing";
import { err, ok, type Result } from "../../domain/result";
import type { QueryContext } from "../core";
import type { PartnerTerms } from "../masters/partners.port";
import type { WriteMeta } from "../ports";

export function writeMeta(ctx: Pick<QueryContext, "clock" | "actor">): WriteMeta {
  return { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId };
}

export function fieldError(field: string, message: string): Result<never> {
  return err("validation", message, { fields: [{ field, message }] });
}

/** 取引日時点の税率（税区分ごと）。税率表にない日付なら失敗 */
export function taxRatesOn(
  ctx: Pick<QueryContext, "stores">,
  date: string,
): Result<Readonly<Record<TaxCategory, number>>> {
  const rates = ratesOn(ctx.stores.settings.listTaxRates(), date);
  if (!rates)
    return err(
      "validation",
      `${date} の時点の税率が設定にありません。管理者に税率表の設定を依頼してください`,
    );
  return ok(rates);
}

/** 取引先の取引条件（締め日・支払月・支払日がそろっているときだけ） */
export function closingTermsOf(partner: PartnerTerms): ClosingTerms | null {
  if (
    partner.closingDay === null ||
    partner.paymentMonthOffset === null ||
    partner.paymentDay === null
  )
    return null;
  return {
    closingDay: partner.closingDay,
    paymentMonthOffset: partner.paymentMonthOffset,
    paymentDay: partner.paymentDay,
  };
}

/** 明細ごとの数（入荷の受入数・仕入返品の数など）を引く。記録のない明細は 0 */
export function countBy<T extends { readonly lineId: string }>(
  rows: readonly T[],
  value: (row: T) => number,
): (lineId: string) => number {
  const map = new Map(rows.map((r) => [r.lineId, value(r)]));
  return (lineId) => map.get(lineId) ?? 0;
}
