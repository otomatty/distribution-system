/**
 * 日次バックアップの保存期間（要件定義書 7章 可用性とバックアップ）。
 * 直近30日分は毎日の分を、それより前は月初（1日）の分を7年間残す。
 */
import { addDays, isBusinessDate } from "./dates";

export const DAILY_RETENTION_DAYS = 30;
export const MONTHLY_RETENTION_YEARS = 7;

/** 残しておく期間を過ぎたバックアップの日付（YYYY-MM-DD）を返す。日付でないものは対象にしない */
export function expiredBackupDates(dates: readonly string[], today: string): string[] {
  const dailyLimit = addDays(today, -DAILY_RETENTION_DAYS);
  const year = Number(today.slice(0, 4)) - MONTHLY_RETENTION_YEARS;
  const monthlyLimit = `${String(year).padStart(4, "0")}${today.slice(4)}`;
  return dates.filter((d) => {
    if (!isBusinessDate(d)) return false;
    if (d >= dailyLimit) return false;
    if (d.endsWith("-01") && d >= monthlyLimit) return false;
    return true;
  });
}
