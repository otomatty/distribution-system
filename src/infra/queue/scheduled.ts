/** Cron Triggers の処理（日次バックアップなど）。 */
export const scheduledTasks: Partial<Record<string, (env: Env) => Promise<void>>> = {};

export async function runScheduled(cron: string, env: Env): Promise<void> {
  const task = scheduledTasks[cron];
  if (task) await task(env);
}
