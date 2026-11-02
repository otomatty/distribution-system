/**
 * メールの送信（要件定義書 7章 帳票のメール送付）。送信の部分は差し替えられる作りにする。
 * 環境変数 MAIL_PROVIDER で選ぶ（切り替えの手順は docs/operations.md 1章）。
 * - email_service（既定）：Cloudflare Email Service（バインディング EMAIL）。EMAIL がない開発・テストでは、送らずにログに出す（宛先は伏せる）
 * - resend：Email Service に問題が出たときの予備。Resend の REST API に fetch で送る（API キーは Secrets の RESEND_API_KEY）
 */
import { z } from "zod";

import { InfraError } from "../errors";
import { log } from "../observability/log";

export interface MailAttachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

export interface MailMessage {
  /** 宛先（Email Service の上限は合わせて50件） */
  readonly to: readonly string[];
  /** 送り主の表示名（自社名）。アドレスは環境変数 MAIL_FROM */
  readonly fromName: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly text: string;
  readonly attachments: readonly MailAttachment[];
  /**
   * 同じメールを二重に送らないための番号（送付履歴の ID など）。Resend は24時間、同じ番号の送信を1回にする。
   * Email Service には渡さない
   */
  readonly idempotencyKey?: string;
}

export interface Mailer {
  /** 送信した場合はメッセージの ID。ログに出しただけなら null */
  send(message: MailMessage): Promise<{ readonly messageId: string | null }>;
}

/** Email Service のエラーコード → 利用者向けの文言と、再試行するか */
const EMAIL_ERRORS: Readonly<Record<string, { message: string; permanent: boolean }>> = {
  E_VALIDATION_ERROR: { message: "宛先や内容の形式が正しくありません", permanent: true },
  E_FIELD_MISSING: { message: "宛先・送り主・件名のどれかがありません", permanent: true },
  E_TOO_MANY_RECIPIENTS: { message: "宛先が多すぎます", permanent: true },
  E_TOO_MANY_ATTACHMENTS: { message: "添付ファイルが多すぎます", permanent: true },
  E_CONTENT_TOO_LARGE: { message: "添付ファイルが大きすぎます（25MiB まで）", permanent: true },
  E_SENDER_NOT_VERIFIED: {
    message: "送信元のドメインが確認されていません（管理者に連絡してください）",
    permanent: true,
  },
  E_SENDER_DOMAIN_NOT_AVAILABLE: {
    message: "送信元のドメインがメール送信に登録されていません（管理者に連絡してください）",
    permanent: true,
  },
  E_RECIPIENT_NOT_ALLOWED: { message: "この宛先には送信できません", permanent: true },
  E_RECIPIENT_SUPPRESSED: {
    message: "この宛先は以前に受け取りを拒否したため送信できません",
    permanent: true,
  },
  E_DELIVERY_FAILED: {
    message: "相手のメールサーバーが受け取りを拒否しました。宛先を確認してください",
    permanent: true,
  },
  E_ACCOUNT_SUSPENDED: {
    message: "メールの送信が停止されています（管理者に連絡してください）",
    permanent: true,
  },
  E_RATE_LIMIT_EXCEEDED: { message: "送信が混み合っています", permanent: false },
  E_DAILY_LIMIT_EXCEEDED: {
    message: "1日の送信数の上限に達しました。明日以降に再送してください",
    permanent: false,
  },
  E_INTERNAL_SERVER_ERROR: {
    message: "メールの送信サービスが一時的に使えません",
    permanent: false,
  },
};

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;
}

export function toMailError(e: unknown): InfraError {
  const code = errorCode(e);
  const known = code === undefined ? undefined : EMAIL_ERRORS[code];
  const detail = { code: code ?? null, error: e instanceof Error ? e.message : String(e) };
  if (known) return new InfraError(`${known.message}（${code}）`, known.permanent, detail);
  return new InfraError("メールを送信できませんでした", false, detail);
}

function emailServiceMailer(binding: SendEmail, fromAddress: string): Mailer {
  return {
    async send(m) {
      try {
        const result = await binding.send({
          to: [...m.to],
          from: { email: fromAddress, name: m.fromName },
          ...(m.replyTo ? { replyTo: m.replyTo } : {}),
          subject: m.subject,
          text: m.text,
          attachments: m.attachments.map((a) => ({
            content: a.content,
            filename: a.fileName,
            type: a.contentType,
            disposition: "attachment" as const,
          })),
        });
        return { messageId: result.messageId };
      } catch (e) {
        throw toMailError(e);
      }
    },
  };
}

/** 宛先を伏せる（取引先の連絡先をログに残さない。AGENTS.md 7章） */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  return at <= 0 ? "***" : `${address[0] ?? ""}***${address.slice(at)}`;
}

/** 開発・テスト用：送らずに、件名と添付の大きさだけをログに出す */
const logMailer: Mailer = {
  send(m) {
    log("info", "mail not sent (no EMAIL binding)", {
      to: m.to.map(maskAddress),
      subject: m.subject,
      attachments: m.attachments.map((a) => ({ fileName: a.fileName, bytes: a.content.length })),
    });
    return Promise.resolve({ messageId: null });
  },
};

// ---- Resend（予備） ------------------------------------------------------------

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const CONFIG_ERROR = {
  message: "メールの送信の設定が正しくありません（管理者に連絡してください）",
  permanent: true,
};

/** Resend のエラー（name）→ 利用者向けの文言と、再試行するか。知らないものは HTTP の状態で分ける */
const RESEND_ERRORS: Readonly<Record<string, { message: string; permanent: boolean }>> = {
  validation_error: { message: "宛先や内容の形式が正しくありません", permanent: true },
  missing_required_field: { message: "宛先・送り主・件名のどれかがありません", permanent: true },
  invalid_parameter: { message: "宛先や内容の形式が正しくありません", permanent: true },
  invalid_attachment: { message: "添付ファイルを送れませんでした", permanent: true },
  invalid_from_address: {
    message: "送信元のアドレスが正しくありません（管理者に連絡してください）",
    permanent: true,
  },
  missing_api_key: CONFIG_ERROR,
  invalid_api_key: CONFIG_ERROR,
  restricted_api_key: CONFIG_ERROR,
  rate_limit_exceeded: { message: "送信が混み合っています", permanent: false },
  daily_quota_exceeded: {
    message: "1日の送信数の上限に達しました。明日以降に再送してください",
    permanent: false,
  },
  monthly_quota_exceeded: {
    message: "1か月の送信数の上限に達しました（管理者に連絡してください）",
    permanent: true,
  },
  concurrent_idempotent_requests: { message: "同じメールを送信中です", permanent: false },
  invalid_idempotent_request: {
    message: "同じ送付で内容の違うメールを送ろうとしました（再送してください）",
    permanent: true,
  },
  application_error: { message: "メールの送信サービスが一時的に使えません", permanent: false },
  internal_server_error: { message: "メールの送信サービスが一時的に使えません", permanent: false },
};

const resendErrorBody = z.object({ name: z.string().optional(), message: z.string().optional() });
const resendSuccessBody = z.object({ id: z.string() });

async function readJson(res: Response): Promise<unknown> {
  try {
    const body: unknown = await res.json();
    return body;
  } catch {
    return null;
  }
}

export function toResendError(status: number, body: unknown): InfraError {
  const parsed = resendErrorBody.safeParse(body);
  const name = parsed.success ? parsed.data.name?.toLowerCase() : undefined;
  const detail = {
    status,
    name: name ?? null,
    error: parsed.success ? (parsed.data.message ?? null) : null,
  };
  const known = name === undefined ? undefined : RESEND_ERRORS[name];
  if (known) return new InfraError(`${known.message}（Resend: ${name}）`, known.permanent, detail);
  if (status === 401 || status === 403) return new InfraError(CONFIG_ERROR.message, true, detail);
  if (status === 429 || status >= 500)
    return new InfraError("メールの送信サービスが一時的に使えません", false, detail);
  return new InfraError("メールの送信を断られました。宛先と内容を確認してください", true, detail);
}

/** 添付の中身（Resend は Base64 の文字列で受け取る）。Workers の btoa を使う（Node.js の Buffer は使わない） */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** 送り主（"自社名" <アドレス>）。表示名の改行や区切りの文字は空白にする */
function fromHeader(name: string, address: string): string {
  const display = name.replaceAll(/[\r\n"\\<>]/g, " ").trim();
  return display === "" ? address : `"${display}" <${address}>`;
}

function resendMailer(apiKey: string, fromAddress: string, fetcher: typeof fetch): Mailer {
  return {
    async send(m) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (m.idempotencyKey) headers["Idempotency-Key"] = m.idempotencyKey.slice(0, 256);
      let res: Response;
      try {
        res = await fetcher(RESEND_ENDPOINT, {
          method: "POST",
          headers,
          body: JSON.stringify({
            from: fromHeader(m.fromName, fromAddress),
            to: [...m.to],
            ...(m.replyTo ? { reply_to: m.replyTo } : {}),
            subject: m.subject,
            text: m.text,
            attachments: m.attachments.map((a) => ({
              filename: a.fileName,
              content: toBase64(a.content),
              content_type: a.contentType,
            })),
          }),
        });
      } catch (e) {
        // 通信の失敗は再試行する
        throw new InfraError("メールを送信できませんでした", false, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      const body = await readJson(res);
      if (!res.ok) throw toResendError(res.status, body);
      const sent = resendSuccessBody.safeParse(body);
      return { messageId: sent.success ? sent.data.id : null };
    },
  };
}

// ---- 送信の部分の選択 ------------------------------------------------------------

/** メールの設定（環境変数・Secrets）。境界で検証してから使う */
const mailConfig = z
  .object({
    MAIL_PROVIDER: z.enum(["email_service", "resend"]).default("email_service"),
    MAIL_FROM: z.email(),
    RESEND_API_KEY: z.string().trim().min(1).optional(),
  })
  .refine((c) => c.MAIL_PROVIDER !== "resend" || c.RESEND_API_KEY !== undefined, {
    path: ["RESEND_API_KEY"],
    message: "MAIL_PROVIDER が resend のときは Secrets に RESEND_API_KEY が必要です",
  });

export interface MailerOptions {
  /** Resend に送る fetch（テストで差し替える） */
  readonly fetch?: typeof fetch;
}

/**
 * 環境に合わせた送信の部分を返す。設定が正しくなければ、再試行しない失敗（InfraError）にする
 * （送付履歴に「設定が正しくありません」と残り、設定を直した後に画面から再送できる）
 */
export function mailerFor(env: Env, options: MailerOptions = {}): Mailer {
  const config = mailConfig.safeParse({
    MAIL_PROVIDER: env.MAIL_PROVIDER || undefined,
    MAIL_FROM: env.MAIL_FROM,
    RESEND_API_KEY: env.RESEND_API_KEY || undefined,
  });
  if (!config.success) {
    throw new InfraError(CONFIG_ERROR.message, true, {
      issues: config.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const c = config.data;
  if (c.MAIL_PROVIDER === "resend" && c.RESEND_API_KEY !== undefined) {
    return resendMailer(
      c.RESEND_API_KEY,
      c.MAIL_FROM,
      options.fetch ?? ((input, init) => fetch(input, init)),
    );
  }
  return env.EMAIL ? emailServiceMailer(env.EMAIL, c.MAIL_FROM) : logMailer;
}
