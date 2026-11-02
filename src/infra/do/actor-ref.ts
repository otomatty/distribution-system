/**
 * 業務 DB に操作者を伝える方法。
 * - auth：Better Auth のユーザー ID（本番の通常のログイン）
 * - dev：開発・テスト用のログイン（ENVIRONMENT が development / test のときだけ有効）
 * - system：Queues や Cron からの内部処理（ブラウザからの入力では作らない）
 */
export type ActorRef =
  | { readonly kind: "auth"; readonly userId: string }
  | { readonly kind: "dev"; readonly email: string }
  | { readonly kind: "system" };

export function isDevAuthAllowed(environment: string): boolean {
  return environment === "development" || environment === "test";
}
