/** Cron Triggers の処理。cron の式（wrangler.jsonc の triggers.crons）→ 処理。 */
import { dailyMaintenance } from "./backup";

export const scheduledTasks: Partial<Record<string, (env: Env) => Promise<void>>> = {
  // 毎日 03:00（日本時間）：日次バックアップ、古いバックアップと受付番号の掃除
  "0 18 * * *": (env) => dailyMaintenance(env),
};

export async function runScheduled(cron: string, env: Env): Promise<void> {
  const task = scheduledTasks[cron];
  if (task) await task(env);
}
