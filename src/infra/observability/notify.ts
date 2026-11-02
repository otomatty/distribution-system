/**
 * 重大なエラーの記録と、管理者へのメール通知（要件定義書 7章 エラーの記録と通知）。
 * 同じエラーは1時間に1回まで知らせる（回数の管理は業務 DB の Durable Object で行う）。
 * 通知に失敗しても、元の処理には影響させない（ログに残すだけ）。
 */
import { businessDb } from "../do/client";
import { mailerFor } from "../mail/mailer";
import { errorFields, log } from "./log";

const NOTIFY_WINDOW_MS = 60 * 60 * 1000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 同じエラーかを見分ける印（数字や ID が違うだけのものは同じとみなす） */
export function errorFingerprint(event: string, error: unknown): string {
  const normalized = messageOf(error)
    .replaceAll(/[0-9A-HJKMNP-TV-Z]{26}/g, "<id>")
    .replaceAll(/\d+/g, "<n>");
  return `${event}|${normalized}`.slice(0, 200);
}

export async function reportCritical(
  env: Env,
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): Promise<void> {
  log("error", event, { ...fields, ...errorFields(error), critical: true });
  try {
    const recipients = await businessDb(env).claimErrorNotification(
      errorFingerprint(event, error),
      NOTIFY_WINDOW_MS,
    );
    if (recipients.length === 0) return;
    const at = new Date().toISOString();
    await mailerFor(env).send({
      to: recipients,
      fromName: "流通管理システム",
      replyTo: null,
      subject: `【流通管理システム】エラーが発生しました（${env.ENVIRONMENT}）`,
      text: [
        "流通管理システムで重大なエラーが発生しました。",
        "",
        `日時（UTC）：${at}`,
        `環境：${env.ENVIRONMENT}`,
        `内容：${event}`,
        `メッセージ：${messageOf(error).slice(0, 500)}`,
        "",
        "詳しくは Workers のログを「critical: true」で検索してください。",
        "同じエラーは1時間に1回だけ通知します。",
      ].join("\n"),
      attachments: [],
    });
  } catch (e) {
    log("warn", "error notification failed", errorFields(e));
  }
}
