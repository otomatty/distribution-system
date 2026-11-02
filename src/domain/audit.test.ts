import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  auditChanges,
  auditLabel,
  parseAuditJson,
} from "./audit";

describe("操作履歴の表示名", () => {
  it("登録した対象と操作は日本語にし、知らない値はそのまま出す", () => {
    expect(auditLabel(AUDIT_ENTITY_LABELS, "purchase_order")).toBe("発注");
    expect(auditLabel(AUDIT_ACTION_LABELS, "cancel_for_reissue")).toBe("再発行のための取消");
    expect(auditLabel(AUDIT_ACTION_LABELS, "something_new")).toBe("something_new");
  });
});

describe("操作履歴の変更前後", () => {
  it("両方あるときは、変更後に記録した項目のうち値が変わったものだけを出す", () => {
    const before = { id: "A", name: "旧", version: 3, active: true, memo: null };
    const after = { name: "新", active: false, memo: "", phone: "0192-00-0000" };
    expect(auditChanges(before, after)).toEqual({
      changes: [
        { path: "name", before: "旧", after: "新" },
        { path: "active", before: "はい", after: "いいえ" },
        { path: "phone", before: null, after: "0192-00-0000" },
      ],
      omitted: 0,
    });
  });

  it("入れ子と配列は項目の名前をつないで比べ、減った行も出す", () => {
    const before = {
      status: "draft",
      lines: [
        { itemId: "I1", quantity: 2 },
        { itemId: "I2", quantity: 1 },
      ],
      totals: { amount: 100 },
    };
    const after = { status: "confirmed", lines: [{ itemId: "I1", quantity: 3 }] };
    expect(auditChanges(before, after).changes).toEqual([
      { path: "status", before: "draft", after: "confirmed" },
      { path: "lines[0].quantity", before: "2", after: "3" },
      { path: "lines[1].itemId", before: "I2", after: null },
      { path: "lines[1].quantity", before: "1", after: null },
    ]);
  });

  it("登録（変更後だけ）と削除（変更前だけ）は記録した項目をすべて出す", () => {
    expect(auditChanges(undefined, { code: "IT000001", tags: [], extra: {} }).changes).toEqual([
      { path: "code", before: null, after: "IT000001" },
      { path: "tags", before: null, after: "（なし）" },
      { path: "extra", before: null, after: "{}" },
    ]);
    expect(auditChanges({ name: "消した商品" }, undefined).changes).toEqual([
      { path: "name", before: "消した商品", after: null },
    ]);
    expect(auditChanges(undefined, undefined)).toEqual({ changes: [], omitted: 0 });
  });

  it("オブジェクトでない値と、深すぎる入れ子はそのまま文字列にする", () => {
    expect(auditChanges("before", "after").changes).toEqual([
      { path: "", before: "before", after: "after" },
    ]);
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(auditChanges(undefined, deep).changes).toEqual([
      { path: "a.b.c.d", before: null, after: '{"e":1}' },
    ]);
  });

  it("多すぎる変更は上限までにし、省いた数を返す", () => {
    const after = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, i]));
    const r = auditChanges(undefined, after, 3);
    expect(r.changes.map((c) => c.path)).toEqual(["f0", "f1", "f2"]);
    expect(r.omitted).toBe(2);
  });

  it("記録した JSON を読み戻す（記録なしは undefined、壊れた JSON は文字列のまま）", () => {
    expect(parseAuditJson(null)).toBeUndefined();
    expect(parseAuditJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseAuditJson("null")).toBeNull();
    expect(parseAuditJson("{oops")).toBe("{oops");
  });
});
