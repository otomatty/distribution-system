/** 表示用の整形（計算はしない。金額の計算は domain 層で行う）。 */
import { formatJapaneseDate } from "../../domain/dates";
import { formatCenti, formatRate, formatYen } from "../../domain/money";
import { formatPostalCode } from "../../domain/validation";

export const yen = (n: number | null | undefined): string =>
  n === null || n === undefined ? "" : `¥${formatYen(n)}`;
export const centiYen = (n: number | null | undefined): string =>
  n === null || n === undefined ? "" : `¥${formatCenti(n)}`;
export const centiPlain = (n: number | null | undefined): string =>
  n === null || n === undefined ? "" : formatCenti(n).replaceAll(",", "");
export const rate = formatRate;
export const qty = (n: number | null | undefined): string =>
  n === null || n === undefined ? "" : n.toLocaleString("ja-JP");
export const date = (d: string | null | undefined): string => d ?? "";
export const jaDate = (d: string | null | undefined): string => (d ? formatJapaneseDate(d) : "");
export const postal = (p: string | null | undefined): string =>
  p ? `〒${formatPostalCode(p)}` : "";
/** ISO の日時を日本時間の「2026-11-02 13:45」にする */
export const dateTime = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return d.toISOString().slice(0, 16).replace("T", " ");
};
