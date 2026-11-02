import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { unwrap, unwrapErr } from "../../tests/support/result";
import {
  attachmentFileName,
  canAttachToSupplierInvoice,
  checkPdfAttachment,
  isPdf,
  isSha256Hex,
  MAX_ATTACHMENT_BYTES,
  supplierInvoiceAttachmentKey,
} from "./attachments";

const PDF_HEAD = new TextEncoder().encode("%PDF-1.7\n");

describe("添付 PDF の検証", () => {
  it("先頭が %PDF- のファイルだけを PDF とみなす", () => {
    expect(isPdf(PDF_HEAD)).toBe(true);
    expect(isPdf(new TextEncoder().encode("%PDF"))).toBe(false);
    expect(isPdf(new TextEncoder().encode("PK\u0003\u0004"))).toBe(false);
    expect(isPdf(new Uint8Array())).toBe(false);
  });

  it("空・10 MB を超えるもの・PDF でないものはエラー", () => {
    expect(unwrap(checkPdfAttachment({ size: 100, head: PDF_HEAD }))).toBe(true);
    expect(unwrap(checkPdfAttachment({ size: MAX_ATTACHMENT_BYTES, head: PDF_HEAD }))).toBe(true);
    expect(unwrapErr(checkPdfAttachment({ size: 0, head: PDF_HEAD })).message).toContain("空");
    expect(
      unwrapErr(checkPdfAttachment({ size: MAX_ATTACHMENT_BYTES + 1, head: PDF_HEAD })).message,
    ).toContain("10 MB");
    expect(
      unwrapErr(checkPdfAttachment({ size: 10, head: new TextEncoder().encode("hello") })).message,
    ).toContain("PDF");
  });

  it("取り消した請求書には添付できない", () => {
    expect(unwrap(canAttachToSupplierInvoice("unpaid"))).toBe(true);
    expect(unwrap(canAttachToSupplierInvoice("paid"))).toBe(true);
    expect(unwrapErr(canAttachToSupplierInvoice("cancelled")).code).toBe("invalid_state");
  });
});

describe("attachmentFileName", () => {
  it("フォルダと制御文字を除き、拡張子 .pdf を付ける", () => {
    expect(attachmentFileName("C:\\Users\\受信\\請求書_10月.pdf")).toBe("請求書_10月.pdf");
    expect(attachmentFileName("/tmp/a/b/invoice.PDF")).toBe("invoice.PDF");
    expect(attachmentFileName("請求書\u0000\n")).toBe("請求書.pdf");
    expect(attachmentFileName("   ")).toBe("請求書.pdf");
  });

  it("長い名前は拡張子を残して200文字に切る（文字の途中では切らない）", () => {
    const long = attachmentFileName(`${"請".repeat(300)}.pdf`);
    expect(Array.from(long)).toHaveLength(200);
    expect(long.endsWith("請.pdf")).toBe(true);
    const emoji = attachmentFileName("😀".repeat(250));
    expect(Array.from(emoji)).toHaveLength(200);
    expect(emoji).toMatch(/^😀+\.pdf$/u);
  });

  it("どんな名前でも、区切り・制御文字を含まない200文字以内の .pdf になる", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400, unit: "binary" }), (name) => {
        const out = attachmentFileName(name);
        const chars = Array.from(out);
        expect(chars.length).toBeLessThanOrEqual(200);
        expect(out).toMatch(/\.pdf$/i);
        for (const ch of chars) {
          const code = ch.codePointAt(0) ?? 0;
          expect(code >= 0x20 && code !== 0x7f && ch !== "/" && ch !== "\\").toBe(true);
        }
      }),
    );
  });
});

describe("保存先と SHA-256", () => {
  it("請求書ごとのフォルダに版ごとのファイル名で置く", () => {
    expect(supplierInvoiceAttachmentKey("01ABC", "f-1")).toBe("supplier-invoices/01ABC/f-1.pdf");
  });

  it("SHA-256 は小文字の16進数64桁", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex("a".repeat(63))).toBe(false);
  });
});
