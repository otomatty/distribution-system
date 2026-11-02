import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { InfraError } from "../errors";
import {
  mailerFor,
  maskAddress,
  toBase64,
  toMailError,
  toResendError,
  type MailMessage,
} from "./mailer";

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

/** Resend の REST API の代わり。受け取った要求を記録し、決めた応答を返す */
function fakeResend(response: () => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit | undefined; body: string }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      init,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return Promise.resolve(response());
  };
  return { requests, fetcher };
}

const resendEnv = { ...env, MAIL_PROVIDER: "resend", RESEND_API_KEY: "test-resend-key" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sendWithResponse(response: Response) {
  return mailerFor(resendEnv, { fetch: fakeResend(() => response).fetcher }).send(message);
}

const networkDown: typeof fetch = () => Promise.reject(new Error("network down"));
// Error でない値で失敗する fetch（例外の中身を文字列にして残すかを確かめる）
const rejectsWithString: typeof fetch = () => Promise.reject("boom");

describe("メールの送信（Resend）", () => {
  it("MAIL_PROVIDER が resend なら、Resend の REST API に添付つきで送る", async () => {
    const fake = fakeResend(() => jsonResponse(200, { id: "re-msg-1" }));
    const mailer = mailerFor(resendEnv, { fetch: fake.fetcher });
    const result = await mailer.send({ ...message, idempotencyKey: "document-send/S1" });
    expect(result).toEqual({ messageId: "re-msg-1" });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.url).toBe("https://api.resend.com/emails");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.headers).toEqual({
      Authorization: "Bearer test-resend-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "document-send/S1",
    });
    expect(JSON.parse(request?.body ?? "")).toEqual({
      from: `"テスト商事" <${env.MAIL_FROM}>`,
      to: ["buyer@example.com"],
      reply_to: "office@example.co.jp",
      subject: message.subject,
      text: "本文",
      attachments: [{ filename: "請求書.pdf", content: "AQI=", content_type: "application/pdf" }],
    });
  });

  it("返信先と受付番号がなければ付けず、表示名の区切りの文字は空白にする", async () => {
    const fake = fakeResend(() => jsonResponse(200, { id: "re-msg-2" }));
    await mailerFor(resendEnv, { fetch: fake.fetcher }).send({
      ...message,
      replyTo: null,
      fromName: '悪い"名前" <x>\r\n',
    });
    const body = JSON.parse(fake.requests[0]?.body ?? "") as Record<string, unknown>;
    expect(body).not.toHaveProperty("reply_to");
    expect(body["from"]).toBe(`"悪い 名前   x" <${env.MAIL_FROM}>`);
    expect(fake.requests[0]?.init?.headers).not.toHaveProperty("Idempotency-Key");
    const empty = fakeResend(() => jsonResponse(200, { id: "re-msg-3" }));
    await mailerFor(resendEnv, { fetch: empty.fetcher }).send({ ...message, fromName: " " });
    const emptyBody = JSON.parse(empty.requests[0]?.body ?? "") as Record<string, unknown>;
    expect(emptyBody["from"]).toBe(env.MAIL_FROM);
  });

  it("成功の応答に ID がなければ messageId は null", async () => {
    const fake = fakeResend(() => new Response("ok", { status: 200 }));
    expect(await mailerFor(resendEnv, { fetch: fake.fetcher }).send(message)).toEqual({
      messageId: null,
    });
  });

  it("Resend のエラーを、利用者向けの文言と再試行するかに分ける", async () => {
    const invalid = await sendWithResponse(
      jsonResponse(422, { statusCode: 422, name: "validation_error", message: "Invalid `to`" }),
    ).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(InfraError);
    expect(invalid).toMatchObject({
      message: "宛先や内容の形式が正しくありません（Resend: validation_error）",
      permanent: true,
      detail: { status: 422, name: "validation_error", error: "Invalid `to`" },
    });
    await expect(
      sendWithResponse(jsonResponse(429, { name: "daily_quota_exceeded" })),
    ).rejects.toMatchObject({
      message:
        "1日の送信数の上限に達しました。明日以降に再送してください（Resend: daily_quota_exceeded）",
      permanent: false,
    });
    // 名前の大文字・小文字の違いは区別しない
    await expect(
      sendWithResponse(jsonResponse(403, { name: "invalid_api_Key" })),
    ).rejects.toMatchObject({
      message:
        "メールの送信の設定が正しくありません（管理者に連絡してください）（Resend: invalid_api_key）",
      permanent: true,
    });
    await expect(sendWithResponse(new Response("", { status: 401 }))).rejects.toMatchObject({
      message: "メールの送信の設定が正しくありません（管理者に連絡してください）",
      permanent: true,
      detail: { status: 401, name: null, error: null },
    });
    await expect(
      sendWithResponse(jsonResponse(503, { name: "something_new" })),
    ).rejects.toMatchObject({
      message: "メールの送信サービスが一時的に使えません",
      permanent: false,
    });
    await expect(
      sendWithResponse(jsonResponse(400, { name: "something_new" })),
    ).rejects.toMatchObject({
      message: "メールの送信を断られました。宛先と内容を確認してください",
      permanent: true,
    });
    expect(toResendError(429, "not an object").permanent).toBe(false);
  });

  it("通信に失敗したら再試行する失敗にする", async () => {
    const failed = await mailerFor(resendEnv, { fetch: networkDown })
      .send(message)
      .catch((e: unknown) => e);
    expect(failed).toMatchObject({
      message: "メールを送信できませんでした",
      permanent: false,
      detail: { error: "network down" },
    });
    await expect(
      mailerFor(resendEnv, { fetch: rejectsWithString }).send(message),
    ).rejects.toMatchObject({
      detail: { error: "boom" },
    });
  });

  it("大きな添付も Base64 にできる（区切って変換する）", () => {
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, i) => i % 256);
    const decoded = Uint8Array.from(atob(toBase64(bytes)), (ch) => ch.charCodeAt(0));
    expect(decoded).toEqual(bytes);
    expect(toBase64(new Uint8Array())).toBe("");
  });
});

describe("メールの設定（環境変数の検証）", () => {
  it("MAIL_PROVIDER がなければ Email Service（EMAIL がなければログに出す）", async () => {
    expect(await mailerFor({ ...env, MAIL_PROVIDER: "" }).send(message)).toEqual({
      messageId: null,
    });
  });

  it("resend なのに RESEND_API_KEY がない、知らない送信の部分、送信元の誤りは、再試行しない失敗にする", () => {
    for (const bad of [
      { MAIL_PROVIDER: "resend", RESEND_API_KEY: "" },
      // テストの環境には RESEND_API_KEY がない
      { MAIL_PROVIDER: "resend" },
      { MAIL_PROVIDER: "sendgrid" },
      { MAIL_FROM: "not-an-address" },
    ]) {
      let error: unknown;
      try {
        mailerFor({ ...env, ...bad });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(InfraError);
      expect(error).toMatchObject({
        message: "メールの送信の設定が正しくありません（管理者に連絡してください）",
        permanent: true,
      });
    }
  });
});
