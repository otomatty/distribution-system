/**
 * 外部サービス（Browser Rendering、Email Service、R2）や非同期処理で起きた失敗。
 * message は画面（処理状況、送付履歴）に出すので、利用者向けの日本語にする。
 * 調べるための詳しい内容は detail に入れ、ログにだけ出す（AGENTS.md 4章 エラー）。
 */
export class InfraError extends Error {
  constructor(
    message: string,
    /** 再試行しても直らない失敗か（宛先の誤り、テンプレートがないなど）。true なら再試行しない */
    readonly permanent: boolean,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "InfraError";
  }
}

/** 想定外の例外を画面に出すときの文言（生の例外メッセージは見せない） */
export const UNEXPECTED_ERROR_MESSAGE =
  "処理中に想定外のエラーが発生しました。時間をおいてやり直しても直らない場合は、管理者に連絡してください";

export function userMessage(error: unknown): string {
  return error instanceof InfraError ? error.message : UNEXPECTED_ERROR_MESSAGE;
}

export function isPermanent(error: unknown): boolean {
  return error instanceof InfraError && error.permanent;
}
