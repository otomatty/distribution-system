/**
 * 業務日（日本時間の日付、YYYY-MM-DD）の計算。現在時刻は引数で受け取る（AGENTS.md 4章）。
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function isBusinessDate(text: string): boolean {
  const m = DATE_RE.exec(text);
  if (!m) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/** 時刻（UTC）を日本時間の業務日にする。 */
export function toBusinessDate(instant: Date): string {
  return new Date(instant.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function toUtcDate(date: string): Date {
  if (!isBusinessDate(date)) throw new RangeError(`不正な日付: ${date}`);
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  const d = toUtcDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function yearOf(date: string): number {
  return toUtcDate(date).getUTCFullYear();
}

function lastDayOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function makeDate(year: number, month0: number, day: number): string {
  const y = year + Math.floor(month0 / 12);
  const m = ((month0 % 12) + 12) % 12;
  const d = Math.min(day, lastDayOfMonth(y, m));
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}

/** 締め日の指定。day は 1〜28、または 31（月末）。 */
export interface ClosingTerms {
  readonly closingDay: number;
  /** 支払月：0 = 当月、1 = 翌月、2 = 翌々月 */
  readonly paymentMonthOffset: number;
  /** 支払日：1〜28、または 31（月末） */
  readonly paymentDay: number;
}

/** 日付が属する締め期間（from〜to、両端を含む）を返す。 */
export function closingPeriod(date: string, closingDay: number): { from: string; to: string } {
  const d = toUtcDate(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const closingThisMonth = makeDate(y, m, closingDay);
  const to = date <= closingThisMonth ? closingThisMonth : makeDate(y, m + 1, closingDay);
  const toD = toUtcDate(to);
  const prevClosing = makeDate(toD.getUTCFullYear(), toD.getUTCMonth() - 1, closingDay);
  return { from: addDays(prevClosing, 1), to };
}

/** 取引日から、取引条件に従った支払期日を計算する。 */
export function paymentDueDate(transactionDate: string, terms: ClosingTerms): string {
  const { to } = closingPeriod(transactionDate, terms.closingDay);
  const closing = toUtcDate(to);
  return makeDate(
    closing.getUTCFullYear(),
    closing.getUTCMonth() + terms.paymentMonthOffset,
    terms.paymentDay,
  );
}

function validDay(d: number): boolean {
  return Number.isInteger(d) && ((d >= 1 && d <= 28) || d === 31);
}

export function validateClosingTerms(terms: ClosingTerms): string | undefined {
  if (!validDay(terms.closingDay)) return "締め日は1〜28日または月末（31）で指定してください";
  if (!validDay(terms.paymentDay)) return "支払日は1〜28日または月末（31）で指定してください";
  if (![0, 1, 2].includes(terms.paymentMonthOffset))
    return "支払月は当月・翌月・翌々月から選んでください";
  return undefined;
}

/** 出荷予定日の初期値 = 納品希望日 − 配送日数 */
export function plannedShipDate(deliveryRequestedOn: string, deliveryDays: number): string {
  return addDays(deliveryRequestedOn, -Math.max(0, deliveryDays));
}

/** 日本語表記（2026年11月2日） */
export function formatJapaneseDate(date: string): string {
  const d = toUtcDate(date);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}
