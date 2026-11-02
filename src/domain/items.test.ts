import { describe, expect, it } from "vitest";

import { firstFreeCode, isValidItemCode, TEMPERATURE_ZONE_LABELS } from "./items";

function* seq() {
  for (let i = 1; ; i += 1) yield `IT${i}`;
}

describe("商品コード", () => {
  it("英数字・ハイフン・下線の30文字以内", () => {
    expect(isValidItemCode("IT000001")).toBe(true);
    expect(isValidItemCode("abc-12_X")).toBe(true);
    expect(isValidItemCode("")).toBe(false);
    expect(isValidItemCode("あいう")).toBe(false);
    expect(isValidItemCode("A".repeat(31))).toBe(false);
  });
  it("自動採番は使われていないコードまで進める", () => {
    const taken = new Set(["IT1", "IT2"]);
    expect(firstFreeCode(seq(), (c) => taken.has(c))).toBe("IT3");
    expect(firstFreeCode(seq(), () => true, 5)).toBeUndefined();
    expect(firstFreeCode([], () => false)).toBeUndefined();
  });
  it("温度帯の表示名", () => {
    expect(TEMPERATURE_ZONE_LABELS.frozen).toBe("冷凍");
  });
});
