/**
 * 帳票のメール送付（send_document）。PDF を添付して送り、送付履歴に結果を残す（要件定義書 3.14）。
 * 失敗が確定したら送付履歴を「失敗」にし、画面とダッシュボードに出す（再送は画面から）。
 */
import { DOCUMENT_TYPE_LABELS } from "../../../domain/documents";
import { sendDocumentPayload } from "../../../usecases/platform/job-payloads";
import type { SendDelivery } from "../../do/business-db";
import { InfraError } from "../../errors";
import { mailerFor, type MailMessage } from "../../mail/mailer";
import { readFile } from "../../storage/files";
import { defineJob } from "../job";
import { ensureRendered, type StoredDocument } from "./render-document";

/** 帳票を送るメールの件名と本文 */
export function documentMail(
  delivery: SendDelivery,
  recipient: string,
  file: StoredDocument,
  content: Uint8Array,
): MailMessage {
  const label = DOCUMENT_TYPE_LABELS[delivery.document.documentType];
  const company = delivery.company;
  const lines = [
    delivery.partner ? `${delivery.partner.name} ${delivery.partner.honorific}` : "ご担当者様",
    "",
    `いつもお世話になっております。${company.name}です。`,
    `${label}（${delivery.document.number}）をお送りします。添付のファイルをご確認ください。`,
    "",
    "このメールは送信専用のアドレスから送っています。お問い合わせは下記までご連絡ください。",
    "",
    company.name,
    ...(company.phone ? [`電話：${company.phone}`] : []),
    ...(company.email ? [`メール：${company.email}`] : []),
  ];
  return {
    to: [recipient],
    fromName: company.name,
    replyTo: company.email,
    subject: `${label}（${delivery.document.number}）のご送付　${company.name}`,
    text: lines.join("\n"),
    attachments: [{ fileName: file.fileName, contentType: file.contentType, content }],
  };
}

export const sendDocumentJob = defineJob({
  payload: sendDocumentPayload,
  async run({ env, db, payload }) {
    const delivery = await db.sendForDelivery(payload.sendId);
    if (!delivery) throw new InfraError("送付履歴が見つかりません", true, payload);
    // 送付済み・失敗済み（同じ処理が重ねて届いた場合）は何もしない
    if (delivery.status !== "pending" || delivery.method !== "email") return {};
    if (delivery.document.cancelled) {
      throw new InfraError("帳票が取消されたため送付しませんでした", true);
    }
    if (!delivery.recipient) throw new InfraError("宛先のメールアドレスがありません", true);
    const file = await ensureRendered(env, db, delivery.document.id);
    const content = await readFile(env.FILES, file.key);
    if (!content) throw new InfraError("保存した PDF が見つかりません", false, { key: file.key });
    await mailerFor(env).send(documentMail(delivery, delivery.recipient, file, content));
    await db.documentSendSucceeded(delivery.sendId);
    return {};
  },
  async onFailed({ db, payload }, message) {
    await db.documentSendFailed(payload.sendId, message);
  },
});
