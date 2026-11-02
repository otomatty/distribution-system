import { describe, expect, it } from "vitest";

import { isJobActive, LISTED_JOB_TYPES, progressPercent } from "./jobs";

describe("jobs", () => {
  it("終わっていない処理", () => {
    expect(isJobActive("pending")).toBe(true);
    expect(isJobActive("queued")).toBe(true);
    expect(isJobActive("running")).toBe(true);
    expect(isJobActive("succeeded")).toBe(false);
    expect(isJobActive("failed")).toBe(false);
  });

  it("進み具合は0〜100の整数（件数が分からないうちは0、完了は100）", () => {
    expect(progressPercent("running", 1, 3)).toBe(33);
    expect(progressPercent("running", 5, 3)).toBe(100);
    expect(progressPercent("running", -1, 3)).toBe(0);
    expect(progressPercent("running", 10, 0)).toBe(0);
    expect(progressPercent("succeeded", 0, 0)).toBe(100);
    expect(progressPercent("failed", 2, 4)).toBe(50);
  });

  it("処理状況に出すのは一括 PDF・CSV・バックアップだけ", () => {
    expect(LISTED_JOB_TYPES).toEqual(["bulk_documents", "export_csv", "backup"]);
  });
});
