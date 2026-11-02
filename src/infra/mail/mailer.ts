/**
 * メールの送信（要件定義書 7章 帳票のメール送付）。送信の部分は差し替えられる作りにする。
 * - 本番・検証：Cloudflare Email Service（バインディング EMAIL）
 * - 開発・テスト（EMAIL がない）：送らずにログに出す（宛先は伏せる）
 * Email Service に問題が出たら、Mailer を実装した Resend の送信に差し替える。
 */
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

export function mailerFor(env: Env): Mailer {
  return env.EMAIL ? emailServiceMailer(env.EMAIL, env.MAIL_FROM) : logMailer;
}
