/**
 * 仕入先請求書の PDF の添付とダウンロード（要件定義書 3.7 Should、7章 電子帳簿保存法）。
 * 1. ファイルを検証する（PDF か、10 MB 以下か）。中身で判定し、拡張子や Content-Type は信じない
 * 2. 版ごとに新しいキーで R2 に保存する（上書きしない）
 * 3. 業務 DB に版を記録し、操作履歴を残す（supplierInvoices.attach）。記録できなかったファイルは消す
 * ダウンロードは権限を確かめた Worker 経由だけ（R2 は公開しない）。
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  attachmentFileName,
  checkPdfAttachment,
  MAX_ATTACHMENT_BYTES,
  supplierInvoiceAttachmentKey,
} from "../../../domain/attachments";
import type { DomainError } from "../../../domain/result";
import { log } from "../../../infra/observability/log";
import { discardFile, fileResponse, putAttachment } from "../../../infra/storage/files";
import { isHtmx, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import { PageHeader } from "../../views/components";
import { Layout } from "../../views/layout";
import { AttachmentSection } from "../../views/supplier-invoice-attachments";

export const supplierInvoiceAttachmentRoutes = new Hono<AppEnv>();

/** multipart の区切りなどの分だけ、ファイルの上限より少し大きく受け付ける */
const MAX_BODY_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;

function validation(message: string): DomainError {
  return { code: "validation", message };
}

/** 添付の欄を返す（htmx は欄だけ、通常の送信は欄と戻るリンクの画面） */
async function section(
  c: Context<AppEnv>,
  id: string,
  extra: { error?: DomainError; notice?: string },
  status: 200 | 404 | 409 | 422 = 200,
) {
  const view = await runQuery(c, "supplierInvoices.get", { id });
  if (!view) return c.text("仕入先請求書が見つかりません", 404);
  const body = <AttachmentSection view={view} error={extra.error} notice={extra.notice} />;
  if (isHtmx(c)) return c.html(body, status);
  return c.html(
    <Layout title="請求書の PDF" actor={c.get("actor")} current={paths.supplierInvoices()}>
      <PageHeader title="請求書の PDF" />
      {body}
      <p>
        <a href={paths.supplierInvoice(id)}>仕入先請求書に戻る</a>
      </p>
    </Layout>,
    status,
  );
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

supplierInvoiceAttachmentRoutes.post(
  "/:id/attachments",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    // htmx は短い本文をそのまま通知に出す
    onError: (c) => c.text("PDF は10 MB 以下にしてください", 413),
  }),
  async (c) => {
    const id = c.req.param("id");
    if (!hasPermission(c.get("actor").roles, "supplierInvoices.manage"))
      return c.text("この操作を行う権限がありません", 403);
    const view = await runQuery(c, "supplierInvoices.get", { id });
    if (!view) return c.text("仕入先請求書が見つかりません", 404);
    // 取り消した請求書などには、ファイルを保存する前に断る（記録のないファイルを作らない）
    if (!view.actions.attach)
      return section(
        c,
        id,
        { error: { code: "invalid_state", message: "この請求書には PDF を添付できません" } },
        409,
      );
    const body = await c.req.parseBody();
    const file = body["file"];
    const keyField = body["_key"];
    const formKey = typeof keyField === "string" && keyField !== "" ? keyField : null;
    if (!(file instanceof File) || file.size === 0)
      return section(c, id, { error: validation("PDF のファイルを選んでください") }, 422);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkPdfAttachment({ size: bytes.byteLength, head: bytes.subarray(0, 8) });
    if (!check.ok) return section(c, id, { error: check.error }, 422);

    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    const fileId = crypto.randomUUID();
    const fileName = attachmentFileName(file.name);
    const r2Key = supplierInvoiceAttachmentKey(id, fileId);
    await putAttachment(c.env.FILES, r2Key, bytes, { fileName, sha256 });
    const result = await runCommand(
      c,
      "supplierInvoices.attach",
      { id, fileId, fileName, size: bytes.byteLength, sha256 },
      formKey,
    );
    // 記録できなかった、または同じ受付番号の再送信（前回のファイルが記録済み）なら、今回のファイルは消す
    if (!result.ok || result.value.fileId !== fileId) {
      if (!(await discardFile(c.env.FILES, r2Key)))
        log("warn", "unrecorded attachment left in R2", { key: r2Key });
    }
    if (!result.ok) return section(c, id, { error: result.error }, 422);
    if (!isHtmx(c)) return redirectTo(c, paths.supplierInvoice(id, { notice: "attached" }));
    return section(c, id, { notice: `PDF を保存しました（${result.value.versionNo}版）` });
  },
);

supplierInvoiceAttachmentRoutes.get("/:id/attachments/:attachmentId", async (c) => {
  const attachment = await runQuery(c, "supplierInvoices.attachment", {
    id: c.req.param("id"),
    attachmentId: c.req.param("attachmentId"),
  });
  if (!attachment) return c.notFound();
  // 受け取った PDF は社外のファイルなので、ダウンロードさせて画面の中では開かない
  const response = await fileResponse(c.env.FILES, attachment.r2Key, attachment.fileName, {
    "Content-Security-Policy": "sandbox",
  });
  return response ?? c.text("ファイルが見つかりません。管理者に連絡してください", 404);
});
