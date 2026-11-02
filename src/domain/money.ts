/**
 * 金額と税の計算。金額はすべて整数で扱う（AGENTS.md 4章）。
 * - 単価：税抜、100分の1円単位（centi-yen）の整数
 * - 金額：円単位の整数
 * - 税率：ベーシスポイント（10% = 1000）
 */

export type RoundingMode = "floor" | "round" | "ceil";
export type TaxCategory = "standard" | "reduced";

export const TAX_CATEGORY_LABELS: Readonly<Record<TaxCategory, string>> = {
  standard: "標準税率",
  reduced: "軽減税率",
};

export const ROUNDING_MODE_LABELS: Readonly<Record<RoundingMode, string>> = {
  floor: "切り捨て",
  round: "四捨五入",
  ceil: "切り上げ",
};

/**
 * 有理数 numerator / denominator を指定の方法で円単位に丸める。
 * 負の値（返品など）は絶対値で丸めてから符号を戻す（切り捨て = 0 に近づける）。
 */
export function roundRatio(numerator: number, denominator: number, mode: RoundingMode): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError("roundRatio: numerator と denominator は安全な整数、denominator は正の値");
  }
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const quotient = Math.floor(abs / denominator);
  const remainder = abs % denominator;
  let rounded: number;
  switch (mode) {
    case "floor":
      rounded = quotient;
      break;
    case "ceil":
      rounded = remainder === 0 ? quotient : quotient + 1;
      break;
    case "round":
      rounded = remainder * 2 >= denominator ? quotient + 1 : quotient;
      break;
  }
  return rounded === 0 ? 0 : sign * rounded;
}

/** 明細の金額（円）= 単価（centi-yen）× 数量 を、明細ごとに丸める。 */
export function lineAmount(unitPriceCenti: number, quantity: number, mode: RoundingMode): number {
  return roundRatio(unitPriceCenti * quantity, 100, mode);
}

/** 税額（円）= 課税対象額 × 税率。請求書1枚ごとに税率ごとに1回だけ使う。 */
export function taxAmount(taxableYen: number, rateBps: number, mode: RoundingMode): number {
  return roundRatio(taxableYen * rateBps, 10_000, mode);
}

/** 税込単価の参考値（centi-yen）。画面での表示用で、請求額の計算には使わない。 */
export function priceWithTaxCenti(
  unitPriceCenti: number,
  rateBps: number,
  mode: RoundingMode,
): number {
  return unitPriceCenti + roundRatio(unitPriceCenti * rateBps, 10_000, mode);
}

export interface TaxRateEntry {
  readonly category: TaxCategory;
  readonly rateBps: number;
  /** 適用開始日（YYYY-MM-DD） */
  readonly effectiveFrom: string;
}

/** 取引日時点で有効な税率を返す。見つからなければ undefined。 */
export function rateOn(
  rates: readonly TaxRateEntry[],
  category: TaxCategory,
  date: string,
): number | undefined {
  let best: TaxRateEntry | undefined;
  for (const r of rates) {
    if (r.category !== category || r.effectiveFrom > date) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best?.rateBps;
}

/**
 * 取引日時点の標準税率・軽減税率。どちらかが税率表になければ undefined
 * （税率表は初期データで2019年10月から入っているので、通常は起きない）。
 */
export function ratesOn(
  rates: readonly TaxRateEntry[],
  date: string,
): Readonly<Record<TaxCategory, number>> | undefined {
  const standard = rateOn(rates, "standard", date);
  const reduced = rateOn(rates, "reduced", date);
  return standard === undefined || reduced === undefined ? undefined : { standard, reduced };
}

export interface AmountLine {
  readonly amount: number;
  readonly taxCategory: TaxCategory;
}

export interface TaxGroup {
  readonly category: TaxCategory;
  readonly rateBps: number;
  readonly subtotal: number;
  readonly tax: number;
}

export interface TaxSummary {
  readonly groups: readonly TaxGroup[];
  readonly subtotal: number;
  readonly tax: number;
  readonly total: number;
}

/**
 * 税率ごとに合計し、税額を税率ごとに1回だけ計算する（インボイス制度の端数処理）。
 * groups は標準税率 → 軽減税率の順で、明細のない税率は含めない。
 */
export function summarizeTax(
  lines: readonly AmountLine[],
  rates: Readonly<Record<TaxCategory, number>>,
  mode: RoundingMode,
): TaxSummary {
  const order: readonly TaxCategory[] = ["standard", "reduced"];
  const groups: TaxGroup[] = [];
  for (const category of order) {
    const matched = lines.filter((l) => l.taxCategory === category);
    if (matched.length === 0) continue;
    const subtotal = matched.reduce((sum, l) => sum + l.amount, 0);
    const rateBps = rates[category];
    groups.push({ category, rateBps, subtotal, tax: taxAmount(subtotal, rateBps, mode) });
  }
  const subtotal = groups.reduce((s, g) => s + g.subtotal, 0);
  const tax = groups.reduce((s, g) => s + g.tax, 0);
  return { groups, subtotal, tax, total: subtotal + tax };
}

/** 画面入力の「1234.56」形式の円を centi-yen の整数に変換する。不正なら undefined。 */
export function parseYenToCenti(text: string): number | undefined {
  const t = text.replaceAll(",", "").trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return undefined;
  const [whole = "0", frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** centi-yen を「1,234.56」形式の文字列にする（端数がなければ小数部を省く）。 */
export function formatCenti(centi: number): string {
  const sign = centi < 0 ? "-" : "";
  const abs = Math.abs(centi);
  const whole = Math.floor(abs / 100).toLocaleString("ja-JP");
  const frac = abs % 100;
  return frac === 0 ? `${sign}${whole}` : `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}

/** 円を「1,234」形式の文字列にする。 */
export function formatYen(yen: number): string {
  return yen.toLocaleString("ja-JP");
}

/** ベーシスポイントを「10%」形式にする。 */
export function formatRate(rateBps: number): string {
  return `${rateBps / 100}%`;
}
