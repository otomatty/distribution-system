import { describe, expect, it } from "vitest";

import { formatDocumentNumber, sequenceKey } from "./numbering";
import { can, isRole } from "./roles";
import {
  formatPostalCode,
  isValidEmail,
  isValidJan,
  normalizePhone,
  normalizePostalCode,
  normalizeRegistrationNumber,
} from "./validation";

describe("validation", () => {
  it("JAN のチェックディジット", () => {
    expect(isValidJan("4901234567894")).toBe(true);
    expect(isValidJan("4901234567890")).toBe(false);
    expect(isValidJan("49123456")).toBe(true);
    expect(isValidJan("12345")).toBe(false);
  });
  it("郵便番号", () => {
    expect(normalizePostalCode("022-0002")).toBe("0220002");
    expect(normalizePostalCode("02200")).toBeUndefined();
    expect(formatPostalCode("0220002")).toBe("022-0002");
    expect(formatPostalCode("abc")).toBe("abc");
  });
  it("電話番号と登録番号とメール", () => {
    expect(normalizePhone("0192-22-1234")).toBe("0192-22-1234");
    expect(normalizePhone("090 1234 5678")).toBe("090-1234-5678");
    expect(normalizePhone("1234")).toBeUndefined();
    expect(normalizePhone("03-12")).toBeUndefined();
    expect(normalizeRegistrationNumber("t1234567890123")).toBe("T1234567890123");
    expect(normalizeRegistrationNumber("T123")).toBeUndefined();
    expect(isValidEmail("a@example.co.jp")).toBe(true);
    expect(isValidEmail("a@b")).toBe(false);
  });
});

describe("numbering", () => {
  it("番号の形式", () => {
    expect(formatDocumentNumber("purchaseOrder", 2026, 123)).toBe("PO-2026-000123");
    expect(formatDocumentNumber("item", 2026, 5)).toBe("IT000005");
    expect(sequenceKey("invoice", 2026)).toBe("invoice:2026");
    expect(sequenceKey("item", 2026)).toBe("item");
    expect(() => formatDocumentNumber("invoice", 2026, 0)).toThrow(RangeError);
  });
});

describe("roles", () => {
  it("権限表", () => {
    expect(can(["purchasing"], "purchaseOrders.manage")).toBe(true);
    expect(can(["purchasing"], "invoices.manage")).toBe(false);
    expect(can(["sales", "accounting"], "invoices.manage")).toBe(true);
    expect(can(["admin"], "employees.manage")).toBe(true);
    expect(can([], "view")).toBe(false);
    expect(isRole("admin")).toBe(true);
    expect(isRole("root")).toBe(false);
  });
});
