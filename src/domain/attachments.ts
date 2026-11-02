/**
 * 仕入先請求書の添付 PDF のルール（要件定義書 3.7 Should、7章 電子帳簿保存法）。
 * - PDF だけ（先頭が %PDF-）、10 MB まで
 * - 一度保存した PDF は消さず、上書きもしない。差し替えは新しい版として追加する（前の版も残る）
 * - 取り消した請求書には添付できない（取り消した後に受け取った PDF は、登録し直した請求書に添付する）
 */
import type { SupplierInvoiceStatus } from "./purchasing";
import { err, ok, type Result } from "./result";

/** 添付できる PDF の大きさの上限（バイト） */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** ファイルの先頭のバイト列が PDF か（拡張子や Content-Type ではなく中身で判定する） */
export function isPdf(head: Uint8Array): boolean {
  return PDF_MAGIC.every((b, i) => head[i] === b);
}

/** 添付するファイルの検証。head はファイルの先頭（少なくとも5バイト） */
export function checkPdfAttachment(file: { size: number; head: Uint8Array }): Result<true> {
  if (file.size === 0) return err("validation", "ファイルが空です。PDF を選び直してください");
  if (file.size > MAX_ATTACHMENT_BYTES) return err("validation", "PDF は10 MB 以下にしてください");
  if (!isPdf(file.head)) return err("validation", "PDF のファイルを選んでください");
  return ok(true);
}

/**
 * 保存するファイル名。フォルダの部分と制御文字を除き、200文字までにする。拡張子がなければ .pdf を付ける。
 * 空なら「請求書.pdf」
 */
export function attachmentFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  // 文字（コードポイント）ごとに扱い、途中で切っても文字が壊れないようにする
  const chars = Array.from(base).filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  const cleaned = chars.join("").trim();
  if (cleaned === "") return "請求書.pdf";
  const withExt = Array.from(/\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`);
  return withExt.length > 200 ? `${withExt.slice(0, 196).join("")}.pdf` : withExt.join("");
}

/** 添付できる請求書の状態（未払い・支払済み。取消は不可） */
export function canAttachToSupplierInvoice(status: SupplierInvoiceStatus): Result<true> {
  return status === "cancelled"
    ? err("invalid_state", "取り消した請求書には PDF を添付できません")
    : ok(true);
}

/** R2 の保存先。請求書ごとのフォルダに、版ごとに別のファイルとして置く（上書きしない） */
export function supplierInvoiceAttachmentKey(invoiceId: string, fileId: string): string {
  return `supplier-invoices/${invoiceId}/${fileId}.pdf`;
}

/** SHA-256 の16進数（小文字64桁）か */
export function isSha256Hex(text: string): boolean {
  return /^[0-9a-f]{64}$/.test(text);
}
