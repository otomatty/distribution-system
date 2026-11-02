import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { InfraError } from "../errors";
import { mailerFor, maskAddress, toMailError, type MailMessage } from "./mailer";

const message: MailMessage = {
  to: ["buyer@example.com"],
  fromName: "テスト商事",
  replyTo: "office@example.co.jp",
  subject: "請求書（INV-2026-000001）のご送付",
  text: "本文",
  attachments: [
    { fileName: "請求書.pdf", contentType: "application/pdf", content: new Uint8Array([1, 2]) },
  ],
};

describe("メールの送信", () => {
  it("Email Service のエラーを、利用者向けの文言と再試行するかに分ける", () => {
    const permanent = toMailError(Object.assign(new Error("x"), { code: "E_VALIDATION_ERROR" }));
    expect(permanent).toBeInstanceOf(InfraError);
    expect(permanent.message).toBe("宛先や内容の形式が正しくありません（E_VALIDATION_ERROR）");
    expect(permanent.permanent).toBe(true);
    const transient = toMailError(
      Object.assign(new Error("x"), { code: "E_INTERNAL_SERVER_ERROR" }),
    );
    expect(transient.permanent).toBe(false);
    const unknown = toMailError(new Error("network"));
    expect(unknown.message).toBe("メールを送信できませんでした");
    expect(unknown.permanent).toBe(false);
    expect(unknown.detail).toMatchObject({ code: null, error: "network" });
    expect(toMailError("boom").detail).toMatchObject({ error: "boom" });
  });

  it("ログに宛先を残さない", () => {
    expect(maskAddress("buyer@example.com")).toBe("b***@example.com");
    expect(maskAddress("invalid")).toBe("***");
  });

  it("EMAIL がない環境では送らずにログに出す", async () => {
    expect(env.EMAIL).toBeUndefined();
    expect(await mailerFor(env).send(message)).toEqual({ messageId: null });
  });

  it("Email Service に送り主・返信先・添付を渡す", async () => {
    const calls: unknown[] = [];
    const binding: SendEmail = {
      send(m: unknown) {
        calls.push(m);
        return Promise.resolve({ messageId: "abc" });
      },
    };
    const result = await mailerFor({ ...env, EMAIL: binding }).send(message);
    expect(result).toEqual({ messageId: "abc" });
    expect(calls[0]).toMatchObject({
      to: ["buyer@example.com"],
      from: { email: env.MAIL_FROM, name: "テスト商事" },
      replyTo: "office@example.co.jp",
      subject: message.subject,
      text: "本文",
      attachments: [{ filename: "請求書.pdf", type: "application/pdf", disposition: "attachment" }],
    });
    const noReply = await mailerFor({ ...env, EMAIL: binding }).send({ ...message, replyTo: null });
    expect(noReply.messageId).toBe("abc");
    expect(calls[1]).not.toHaveProperty("replyTo");
  });

  it("送信に失敗したら InfraError にする", async () => {
    const binding = {
      send: () => Promise.reject(Object.assign(new Error("x"), { code: "E_DAILY_LIMIT_EXCEEDED" })),
    } as unknown as SendEmail;
    await expect(mailerFor({ ...env, EMAIL: binding }).send(message)).rejects.toThrow(
      "1日の送信数の上限に達しました",
    );
  });
});
