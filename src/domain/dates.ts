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

/**
 * date の時点で締め終わっている、最も新しい締め期間。date が締め日ならその日で終わる期間、
 * そうでなければ1つ前の期間（仕入先請求書の登録で、請求の対象の入荷を選んでおく範囲）。
 */
export function latestClosedPeriod(date: string, closingDay: number): { from: string; to: string } {
  const current = closingPeriod(date, closingDay);
  return current.to === date ? current : closingPeriod(addDays(current.from, -1), closingDay);
}

/** date を含む週（月曜〜日曜） */
export function weekRange(date: string): { from: string; to: string } {
  const day = toUtcDate(date).getUTCDay();
  const fromMonday = (day + 6) % 7;
  const from = addDays(date, -fromMonday);
  return { from, to: addDays(from, 6) };
}

/** 業務日の月（YYYY-MM） */
export function monthOf(date: string): string {
  return toUtcDate(date).toISOString().slice(0, 7);
}

/** YYYY-MM の検証 */
export function isMonth(text: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text);
}

/** from〜to（YYYY-MM、両端を含む）の月の一覧。to が from より前なら空 */
export function monthsBetween(from: string, to: string, max = 36): string[] {
  if (!isMonth(from) || !isMonth(to)) return [];
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (;;) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    if (month > to || out.length >= max) break;
    out.push(month);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** 月の初日と末日（YYYY-MM-DD） */
export function monthRange(month: string): { from: string; to: string } {
  const y = Number(month.slice(0, 4));
  const m0 = Number(month.slice(5, 7)) - 1;
  return { from: makeDate(y, m0, 1), to: makeDate(y, m0, 31) };
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
