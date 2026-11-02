import { describe, expect, it } from "vitest";

import {
  canRerender,
  canRetrySend,
  DOCUMENT_SEND_PERMISSIONS,
  DOCUMENT_TYPES,
  documentFileName,
  isDocumentType,
  sendBlocker,
} from "./documents";
import { can } from "./roles";

describe("documents", () => {
  it("作成済みの PDF は作り直さない（電子帳簿保存法）", () => {
    expect(canRerender("failed")).toBe(true);
    expect(canRerender("pending")).toBe(true);
    expect(canRerender("ready")).toBe(false);
  });

  it("取消済み・PDF の作成に失敗した帳票は送付できない", () => {
    expect(sendBlocker({ cancelled: false, status: "ready" })).toBeUndefined();
    expect(sendBlocker({ cancelled: false, status: "pending" })).toBeUndefined();
    expect(sendBlocker({ cancelled: true, status: "ready" })).toContain("取消済み");
    expect(sendBlocker({ cancelled: false, status: "failed" })).toContain("PDF の作成に失敗");
  });

  it("再送できるのは、メールで失敗した最新の送付だけ", () => {
    expect(canRetrySend({ method: "email", status: "failed" }, true)).toBe(true);
    expect(canRetrySend({ method: "email", status: "failed" }, false)).toBe(false);
    expect(canRetrySend({ method: "email", status: "sent" }, true)).toBe(false);
    expect(canRetrySend({ method: "manual", status: "failed" }, true)).toBe(false);
  });

  it("送付の権限は権限表のとおり（発注書は仕入、納品書は受注・出荷、請求書と返還請求書は経理）", () => {
    expect(can(["purchasing"], DOCUMENT_SEND_PERMISSIONS.purchase_order)).toBe(true);
    expect(can(["sales"], DOCUMENT_SEND_PERMISSIONS.purchase_order)).toBe(false);
    expect(can(["sales"], DOCUMENT_SEND_PERMISSIONS.delivery_note)).toBe(true);
    expect(can(["accounting"], DOCUMENT_SEND_PERMISSIONS.delivery_note)).toBe(false);
    expect(can(["accounting"], DOCUMENT_SEND_PERMISSIONS.invoice)).toBe(true);
    expect(can(["accounting"], DOCUMENT_SEND_PERMISSIONS.credit_note)).toBe(true);
    expect(can(["sales"], DOCUMENT_SEND_PERMISSIONS.credit_note)).toBe(false);
    for (const type of DOCUMENT_TYPES)
      expect(can(["admin"], DOCUMENT_SEND_PERMISSIONS[type])).toBe(true);
  });

  it("ファイル名は種類と番号（ファイル名に使えない文字は置き換える）", () => {
    expect(documentFileName("invoice", "INV-2026-000001", "pdf")).toBe(
      "請求書_INV-2026-000001.pdf",
    );
    expect(documentFileName("credit_note", "CN/2026 01", "html")).toBe(
      "返還請求書_CN_2026_01.html",
    );
  });

  it("帳票の種類の判定", () => {
    expect(isDocumentType("delivery_note")).toBe(true);
    expect(isDocumentType("receipt")).toBe(false);
  });
});
