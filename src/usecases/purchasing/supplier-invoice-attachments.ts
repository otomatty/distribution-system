/**
 * 仕入先請求書の PDF の添付（要件定義書 3.7 Should、7章 電子帳簿保存法）。
 * - 受け取った PDF を R2 に保存し、版ごとに記録する。一度保存した版は消さず、上書きもしない
 * - 差し替えは新しい版として追加する（画面は最新の版を表示し、前の版もダウンロードできる）
 * - ファイルの中身の検証（PDF か、10 MB 以下か）と R2 への保存は web 層で行い、ここでは記録と操作履歴を受け持つ
 *   （ユースケースは同期的に実行されるため、ファイルの読み書きはできない）
 */
import { z } from "zod";

import {
  attachmentFileName,
  canAttachToSupplierInvoice,
  isSha256Hex,
  MAX_ATTACHMENT_BYTES,
  supplierInvoiceAttachmentKey,
} from "../../domain/attachments";
import { err, ok } from "../../domain/result";
import { defineCommand, defineQuery } from "../core";
import { idSchema } from "../schemas";
import { writeMeta } from "./common";
import type { SupplierInvoiceAttachmentRecord } from "./supplier-invoices.port";

export const attachSupplierInvoicePdf = defineCommand({
  permission: "supplierInvoices.manage",
  input: z.object({
    id: idSchema,
    /** R2 のファイル名に使う ID（web 層で作った UUID。保存先はこの ID と請求書の ID から決める） */
    fileId: z.uuid(),
    fileName: z.string().max(1000),
    size: z
      .number()
      .int()
      .min(1, "ファイルが空です")
      .max(MAX_ATTACHMENT_BYTES, "PDF は10 MB 以下にしてください"),
    sha256: z.string().refine(isSha256Hex, "ファイルの確認用の値が正しくありません"),
  }),
  run(ctx, input) {
    const invoice = ctx.stores.supplierInvoices.get(input.id);
    if (!invoice) return err("not_found", "仕入先請求書が見つかりません");
    const allowed = canAttachToSupplierInvoice(invoice.status);
    if (!allowed.ok) return allowed;
    const previous = ctx.stores.supplierInvoices.attachments(input.id);
    const attachmentId = ctx.ids.next();
    const row = {
      id: attachmentId,
      supplierInvoiceId: input.id,
      r2Key: supplierInvoiceAttachmentKey(input.id, input.fileId),
      fileName: attachmentFileName(input.fileName),
      size: input.size,
      sha256: input.sha256,
    };
    ctx.stores.supplierInvoices.insertAttachment(row, writeMeta(ctx));
    const versionNo = previous.length + 1;
    ctx.audit.record({
      entityType: "supplier_invoice",
      entityId: input.id,
      action: "attach_pdf",
      before: { latestAttachmentId: previous[0]?.id ?? null, versions: previous.length },
      after: { attachmentId, versionNo, ...row },
    });
    return ok({ id: input.id, attachmentId, fileId: input.fileId, versionNo });
  },
});

/** 添付した PDF の1つの版（ダウンロード用）。請求書の ID と版の ID が合わなければ null */
export const getSupplierInvoiceAttachment = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema, attachmentId: idSchema }),
  run(ctx, { id, attachmentId }): SupplierInvoiceAttachmentRecord | null {
    return ctx.stores.supplierInvoices.attachments(id).find((a) => a.id === attachmentId) ?? null;
  },
});
