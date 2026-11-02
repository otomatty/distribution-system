/**
 * 帳票（発注書・納品書・請求書・返還請求書）の PDF 化と送付の決まり（要件定義書 3.10・3.14・7章 電子帳簿保存法）。
 */
import type { Permission } from "./roles";

export const DOCUMENT_TYPES = [
  "purchase_order",
  "delivery_note",
  "invoice",
  "credit_note",
] as const;
/** 帳票の種類（電子帳簿保存法の検索対象） */
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Readonly<Record<DocumentType, string>> = {
  purchase_order: "発注書",
  delivery_note: "納品書",
  invoice: "請求書",
  credit_note: "返還請求書",
};

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value);
}

/**
 * 帳票の種類ごとに、送付（メール・手動送付の記録・再送）に必要な権限。
 * 権限表（要件定義書 2章）の「発注の送付」「納品書の発行」「請求書・返還請求書」に合わせる。
 */
export const DOCUMENT_SEND_PERMISSIONS: Readonly<Record<DocumentType, Permission>> = {
  purchase_order: "purchaseOrders.manage",
  delivery_note: "shipments.manage",
  invoice: "invoices.manage",
  credit_note: "invoices.manage",
};

/** 用紙の向き。帳票は A4 縦が基本で、発送リストなどは A4 横 */
export type Orientation = "portrait" | "landscape";

/** PDF の作成状況 */
export type RenderStatus = "pending" | "ready" | "failed";

export const RENDER_STATUS_LABELS: Readonly<Record<RenderStatus, string>> = {
  pending: "PDF 作成中",
  ready: "PDF 作成済み",
  failed: "PDF 作成失敗",
};

/**
 * PDF を作り直せるか。作成済みの PDF は発行時点の記録（電子帳簿保存法）なので作り直さない。
 * 作成に失敗したもの・作成待ちのまま止まったものだけを作り直せる。
 */
export function canRerender(status: RenderStatus): boolean {
  return status !== "ready";
}

export type SendMethod = "email" | "manual";
export type SendStatus = "pending" | "sent" | "failed";

export const SEND_METHOD_LABELS: Readonly<Record<SendMethod, string>> = {
  email: "メール",
  manual: "手動（FAX など）",
};

export const SEND_STATUS_LABELS: Readonly<Record<SendStatus, string>> = {
  pending: "送信中",
  sent: "送付済み",
  failed: "失敗",
};

/** 帳票を送付できない理由。送付できるなら undefined */
export function sendBlocker(doc: {
  readonly cancelled: boolean;
  readonly status: RenderStatus;
}): string | undefined {
  if (doc.cancelled) return "取消済みの帳票は送付できません";
  if (doc.status === "failed") {
    return "PDF の作成に失敗しているため送付できません。管理者に PDF の作り直しを依頼してください";
  }
  return undefined;
}

/**
 * 送付をやり直せるか。メールで送って失敗し、その後にまだ送り直していないもの（帳票の最新の送付）だけ。
 */
export function canRetrySend(
  send: { readonly method: SendMethod; readonly status: SendStatus },
  isLatest: boolean,
): boolean {
  return send.method === "email" && send.status === "failed" && isLatest;
}

/** ダウンロードやメールの添付に使うファイル名（例：請求書_INV-2026-000001.pdf） */
export function documentFileName(type: DocumentType, number: string, extension: string): string {
  const safe = number.replaceAll(/[\\/:*?"<>|\s]/g, "_");
  return `${DOCUMENT_TYPE_LABELS[type]}_${safe}.${extension}`;
}
