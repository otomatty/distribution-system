// wrangler types が生成しない秘密情報と、環境によっては存在しないバインディングの型。
interface __BaseEnv_Env {
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Cloudflare Email Service（本番・検証のみ。開発ではログに出力する） */
  EMAIL?: SendEmail;
  /** Browser Rendering（本番・検証のみ。開発では HTML のまま保存する） */
  BROWSER?: Fetcher;
}
