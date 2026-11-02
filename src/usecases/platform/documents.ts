/**
 * 帳票の検索・送付・PDF の作り直し（要件定義書 3.14 帳票の送付、5章 帳票の検索、7章 電子帳簿保存法）。
 * 帳票の発行は各区分のユースケースが ctx.documents.issue(...) で行う。
 */
import { z } from "zod";

import {
  canRerender,
  canRetrySend,
  DOCUMENT_SEND_PERMISSIONS,
  DOCUMENT_TYPES,
  sendBlocker,
  type DocumentType,
} from "../../domain/documents";
import { err, ok, type Result } from "../../domain/result";
import { can } from "../../domain/roles";
import {
  defineCommand,
  defineQuery,
  STALE_VERSION_MESSAGE,
  type Actor,
  type QueryContext,
} from "../core";
import { emailInput } from "../masters/contact";
import type { PartnerRecord } from "../masters/partners.port";
import { idSchema, optionalBusinessDate, optionalText, pageInput } from "../schemas";
import type { DocumentFilter, DocumentRecord, DocumentSendRecord } from "./documents.port";

const amount = z
  .number()
  .int("円単位の整数で入力してください")
  .min(-9_999_999_999)
  .max(9_999_999_999)
  .nullable()
  .optional()
  .transform((v) => v ?? undefined);

const searchInput = pageInput
  .extend({
    dateFrom: optionalBusinessDate,
    dateTo: optionalBusinessDate,
    amountMin: amount,
    amountMax: amount,
    partnerId: z.string().max(64).optional(),
    documentType: z.enum(DOCUMENT_TYPES).optional(),
    number: z.string().trim().max(50).optional(),
    cancelled: z.enum(["exclude", "only"]).optional(),
    renderStatus: z.enum(["pending", "ready", "failed"]).optional(),
    sendStatus: z.enum(["failed", "sent", "unsent"]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.dateFrom && v.dateTo && v.dateFrom > v.dateTo) {
      ctx.addIssue({
        code: "custom",
        path: ["dateTo"],
        message: "終わりの日付は始まりの日付以降にしてください",
      });
    }
    if (v.amountMin !== undefined && v.amountMax !== undefined && v.amountMin > v.amountMax) {
      ctx.addIssue({
        code: "custom",
        path: ["amountMax"],
        message: "上限の金額は下限の金額以上にしてください",
      });
    }
  });

function toFilter(v: z.output<typeof searchInput>): DocumentFilter {
  return {
    dateFrom: v.dateFrom ?? undefined,
    dateTo: v.dateTo ?? undefined,
    amountMin: v.amountMin,
    amountMax: v.amountMax,
    partnerId: v.partnerId || undefined,
    documentType: v.documentType,
    number: v.number || undefined,
    cancelled: v.cancelled,
    renderStatus: v.renderStatus,
    sendStatus: v.sendStatus,
  };
}

/** 帳票の種類ごとの送付の権限（要件定義書 2章の権限表）。持っていなければ失敗 */
function checkSendPermission(actor: Actor, type: DocumentType): Result<true> {
  if (!can(actor.roles, DOCUMENT_SEND_PERMISSIONS[type])) {
    return err("forbidden", "この帳票を送付する権限がありません");
  }
  return ok(true);
}

/** 送付できる帳票を取り出す（存在・権限・取消・PDF の状態を確かめる） */
function sendableDocument(
  ctx: Pick<QueryContext, "actor" | "stores">,
  documentId: string,
): Result<DocumentRecord> {
  const doc = ctx.stores.documents.get(documentId);
  if (!doc) return err("not_found", "帳票が見つかりません");
  const allowed = checkSendPermission(ctx.actor, doc.documentType);
  if (!allowed.ok) return allowed;
  const blocker = sendBlocker(doc);
  if (blocker) return err("invalid_state", blocker);
  return ok(doc);
}

export const searchDocuments = defineQuery({
  permission: "view",
  input: searchInput,
  run(ctx, input) {
    return ctx.stores.documents.search(toFilter(input), input.page, input.pageSize);
  },
});

export interface DocumentDetail {
  readonly document: DocumentRecord;
  /** 送付履歴（新しい順） */
  readonly sends: readonly DocumentSendRecord[];
  /** 送り直せる送付（最新の送付がメールで失敗し、操作者に送付の権限がある場合） */
  readonly retryableSendId: string | null;
  readonly partner: Pick<
    PartnerRecord,
    "id" | "name" | "honorific" | "email" | "fax" | "defaultSendMethod"
  > | null;
  /** PDF 化に失敗した理由 */
  readonly renderError: string | null;
  /** 操作者がこの帳票を送付できるか（権限） */
  readonly canSend: boolean;
  /** 送付できない理由（取消済み、PDF の作成失敗） */
  readonly sendBlocker: string | null;
  readonly canRerender: boolean;
}

export const getDocument = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): DocumentDetail | null {
    const document = ctx.stores.documents.get(id);
    if (!document) return null;
    const canSend = can(ctx.actor.roles, DOCUMENT_SEND_PERMISSIONS[document.documentType]);
    const blocker = sendBlocker(document) ?? null;
    const partner = ctx.stores.partners.get(document.partnerId);
    const sends = ctx.stores.documents.sends(id);
    const retryable = sends.find((s) => canRetrySend(s, s.isLatest));
    return {
      document,
      sends,
      retryableSendId: canSend && blocker === null && retryable ? retryable.id : null,
      partner: partner
        ? {
            id: partner.id,
            name: partner.name,
            honorific: partner.honorific,
            email: partner.email,
            fax: partner.fax,
            defaultSendMethod: partner.defaultSendMethod,
          }
        : null,
      renderError: document.status === "failed" ? ctx.stores.documents.renderError(id) : null,
      canSend,
      sendBlocker: blocker,
      canRerender: can(ctx.actor.roles, "platform.admin") && canRerender(document.status),
    };
  },
});

/** ダッシュボード用：送付に失敗した帳票（操作者が送付できる種類だけ）と、PDF 化に失敗した帳票 */
export const documentAttention = defineQuery({
  permission: "view",
  input: z.object({}),
  run(ctx) {
    const types = DOCUMENT_TYPES.filter((t) => can(ctx.actor.roles, DOCUMENT_SEND_PERMISSIONS[t]));
    return {
      failedSends:
        types.length > 0
          ? ctx.stores.documents.count({ sendStatus: "failed", documentTypes: types })
          : 0,
      /** 管理者だけに見せる（それ以外は null） */
      failedRenders: can(ctx.actor.roles, "platform.admin")
        ? ctx.stores.documents.count({ renderStatus: "failed" })
        : null,
    };
  },
});

export const sendDocument = defineCommand({
  // 帳票の種類によって必要な権限が変わるため、中で判定する（DOCUMENT_SEND_PERMISSIONS）
  permission: "view",
  input: z.object({ documentId: idSchema, recipient: emailInput }),
  run(ctx, { documentId, recipient }) {
    const found = sendableDocument(ctx, documentId);
    if (!found.ok) return found;
    const doc = found.value;
    const to = recipient ?? ctx.stores.partners.get(doc.partnerId)?.email ?? null;
    if (!to) {
      return err("validation", "宛先のメールアドレスを入力してください", {
        fields: [{ field: "recipient", message: "宛先のメールアドレスを入力してください" }],
      });
    }
    const sendId = ctx.documents.sendEmail(doc.id, to);
    ctx.audit.record({
      entityType: "document",
      entityId: doc.id,
      action: "send_email",
      after: { sendId, recipient: to },
    });
    return ok({ sendId });
  },
});

export const recordManualSend = defineCommand({
  permission: "view",
  input: z.object({ documentId: idSchema, note: optionalText(500) }),
  run(ctx, { documentId, note }) {
    const found = sendableDocument(ctx, documentId);
    if (!found.ok) return found;
    const sendId = ctx.documents.recordManualSend(found.value.id, note);
    ctx.audit.record({
      entityType: "document",
      entityId: found.value.id,
      action: "record_manual_send",
      after: { sendId, note },
    });
    return ok({ sendId });
  },
});

export const retrySend = defineCommand({
  permission: "view",
  input: z.object({ sendId: idSchema }),
  run(ctx, { sendId }) {
    const previous = ctx.stores.documents.getSend(sendId);
    if (!previous) return err("not_found", "送付履歴が見つかりません");
    const found = sendableDocument(ctx, previous.documentId);
    if (!found.ok) return found;
    if (!previous.recipient || !canRetrySend(previous, previous.isLatest)) {
      return err("invalid_state", "この送付はやり直せません。画面を開き直してください");
    }
    const id = ctx.documents.sendEmail(previous.documentId, previous.recipient);
    ctx.audit.record({
      entityType: "document",
      entityId: previous.documentId,
      action: "retry_send",
      before: { sendId },
      after: { sendId: id, recipient: previous.recipient },
    });
    return ok({ sendId: id });
  },
});

export const rerenderDocument = defineCommand({
  permission: "platform.admin",
  input: z.object({ documentId: idSchema }),
  run(ctx, { documentId }) {
    const doc = ctx.stores.documents.get(documentId);
    if (!doc) return err("not_found", "帳票が見つかりません");
    if (!canRerender(doc.status)) {
      return err(
        "invalid_state",
        "作成済みの PDF は作り直せません（発行時点の記録として保存しています）",
      );
    }
    const meta = { at: ctx.clock.now().toISOString(), by: ctx.actor.employeeId };
    if (!ctx.stores.documents.resetRender(doc.id, doc.version, meta)) {
      return err("conflict", STALE_VERSION_MESSAGE);
    }
    const jobId = ctx.jobs.enqueue("render_document", { documentId: doc.id });
    ctx.audit.record({
      entityType: "document",
      entityId: doc.id,
      action: "rerender",
      before: { status: doc.status },
      after: { status: "pending", jobId },
    });
    return ok({ jobId });
  },
});
