/**
 * 業務 DB を特定の時点に戻す（要件定義書 7章 可用性とバックアップ：Durable Objects の特定時点への復元（30日））。
 * 戻す時刻・確認の入力・本番の追加の鍵を確かめる規則。現在時刻は引数で受け取る。手順は docs/operations.md 3章。
 */
import { formatJstDateTime } from "./dates";

/** 戻せる範囲（Durable Objects の特定時点への復元は過去30日） */
export const RESTORE_WINDOW_DAYS = 30;
/** 本番の鍵（RESTORE_UNLOCK_UNTIL）に入れてよい期限の長さ */
export const RESTORE_UNLOCK_MAX_HOURS = 24;

const HOUR_MS = 3_600_000;

/** 戻す時刻の誤り。戻せるなら null */
export function restoreTargetError(target: Date, now: Date): string | null {
  const age = now.getTime() - target.getTime();
  if (Number.isNaN(age)) return "日時を正しく入力してください";
  if (age <= 0) return "今より前の日時を指定してください";
  if (age > RESTORE_WINDOW_DAYS * 24 * HOUR_MS) {
    return `戻せるのは過去${RESTORE_WINDOW_DAYS}日以内です。それより前は日次バックアップから戻します`;
  }
  return null;
}

/** 確認のために入力してもらう文字列（戻す日時。日本時間の秒まで） */
export function restoreConfirmationText(target: Date): string {
  return formatJstDateTime(target);
}

/** 確認の入力が、戻す日時と一致するか（前後の空白は無視する） */
export function confirmsRestore(target: Date, typed: string): boolean {
  return typed.trim() === restoreConfirmationText(target);
}

/** 本番として扱う環境。開発・テスト・検証のほかは、--env を付けずに配備したものも含めて本番として扱う */
export function isProductionLike(environment: string): boolean {
  return !["development", "test", "staging"].includes(environment);
}

/**
 * 本番の追加の鍵。本番では、管理者の操作に加えて、運用担当（Cloudflare の権限を持つ人）が Secrets の
 * RESTORE_UNLOCK_UNTIL に「今から24時間以内の時刻」（ISO 8601）を入れている間だけ復元できる。
 * 開いていれば null、閉じていればその理由
 */
export function restoreLockError(
  environment: string,
  unlockUntil: string | undefined,
  now: Date,
): string | null {
  if (!isProductionLike(environment)) return null;
  if (unlockUntil === undefined || unlockUntil.trim() === "") {
    return "本番環境では、運用担当が RESTORE_UNLOCK_UNTIL を設定するまで復元できません（docs/operations.md 3章）";
  }
  const until = Date.parse(unlockUntil.trim());
  if (Number.isNaN(until)) {
    return "RESTORE_UNLOCK_UNTIL の日時を読めません（2026-11-02T15:00:00+09:00 のような ISO 8601 の形で設定してください）";
  }
  if (until <= now.getTime())
    return "RESTORE_UNLOCK_UNTIL の期限が過ぎています。設定し直してください";
  if (until - now.getTime() > RESTORE_UNLOCK_MAX_HOURS * HOUR_MS) {
    return `RESTORE_UNLOCK_UNTIL は今から${RESTORE_UNLOCK_MAX_HOURS}時間以内の時刻にしてください`;
  }
  return null;
}
