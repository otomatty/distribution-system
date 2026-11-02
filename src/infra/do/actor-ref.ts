/**
 * 業務 DB に操作者を伝える方法。
 * - auth：Better Auth のユーザー ID（本番の通常のログイン）
 * - dev：開発・テスト用のログイン（ENVIRONMENT が development / test のときだけ有効）
 * - system：Queues や Cron からの内部処理（ブラウザからの入力では作らない）
 * - employee：Queues の処理を、依頼した社員の権限で行う（CSV の非同期出力など。ブラウザからの入力では作らない）
 */
export type ActorRef =
  | { readonly kind: "auth"; readonly userId: string }
  | { readonly kind: "dev"; readonly email: string }
  | { readonly kind: "system" }
  | { readonly kind: "employee"; readonly employeeId: string };

/** 画面を通らない内部の処理の操作者（受付番号なしで操作を実行できる。BusinessDb.internalCommand） */
export type InternalActorRef = Extract<ActorRef, { readonly kind: "system" | "employee" }>;

export function isInternalActorRef(ref: { readonly kind: string }): boolean {
  return ref.kind === "system" || ref.kind === "employee";
}

export function isDevAuthAllowed(environment: string): boolean {
  return environment === "development" || environment === "test";
}
