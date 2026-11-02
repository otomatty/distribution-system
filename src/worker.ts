/** Worker のエントリーポイント（画面・API、Queues、Cron） */
import { reportCritical } from "./infra/observability/notify";
import { createApp } from "./web/app";

export { BusinessDb } from "./infra/do/business-db";

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),

  async queue(batch, env) {
    // 非同期処理（帳票の PDF 化、メール送付、一括処理など）は infra/queue で処理する
    const { handleJobBatch } = await import("./infra/queue/consumer");
    await handleJobBatch(batch, env);
  },

  async scheduled(controller, env) {
    try {
      const { runScheduled } = await import("./infra/queue/scheduled");
      await runScheduled(controller.cron, env);
    } catch (e) {
      // 定期処理の失敗は管理者にメールで知らせる（同じエラーは1時間に1回まで）
      await reportCritical(env, "scheduled task failed", e, { cron: controller.cron });
      throw e;
    }
  },
} satisfies ExportedHandler<Env, { jobId: string }>;
