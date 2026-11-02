/**
 * 止まった処理の片付け（毎時の Cron）。Worker が CPU 時間の上限などで途中で止まると、処理の結果を記録できず、
 * Queues の再試行を使い切った後も「処理中」のままになる。一定時間たっても終わらない処理を失敗にして、
 * 処理状況・送付履歴・ダッシュボードに出す（帳票の送付は画面から再送できる）。
 */
import { businessDb } from "../do/client";
import { log } from "../observability/log";

/** これより長く進み具合の記録がない処理を、止まったとみなす */
export const STALE_JOB_MINUTES = 60;

export const STALE_JOB_MESSAGE =
  "処理が時間内に終わりませんでした。件数を減らすか、時間をおいてやり直してください";

export async function failStaleJobs(env: Env, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - STALE_JOB_MINUTES * 60_000).toISOString();
  const count = await businessDb(env).failStaleJobs(before, STALE_JOB_MESSAGE);
  if (count > 0) log("error", "stale jobs marked as failed", { count, before });
  return count;
}
