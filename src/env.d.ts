// wrangler types が生成しない秘密情報の型。
// EMAIL（Email Service）と BROWSER（Browser Rendering）は wrangler.jsonc の staging / production にだけあり、
// 生成される型でも省略可能になる（開発とテストでは、メールはログに出し、帳票は HTML のまま保存する）。
interface __BaseEnv_Env {
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** MAIL_PROVIDER が resend のときだけ使う（docs/operations.md 1章） */
  RESEND_API_KEY?: string;
}
