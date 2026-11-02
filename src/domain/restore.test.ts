import { describe, expect, it } from "vitest";

import {
  confirmsRestore,
  isProductionLike,
  restoreConfirmationText,
  restoreLockError,
  restoreTargetError,
} from "./restore";

const now = new Date("2026-11-02T03:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("業務 DB を特定の時点に戻す", () => {
  it("戻せるのは今より前で、過去30日以内", () => {
    expect(restoreTargetError(minutesAgo(1), now)).toBeNull();
    expect(restoreTargetError(minutesAgo(30 * 24 * 60), now)).toBeNull();
    expect(restoreTargetError(minutesAgo(30 * 24 * 60 + 1), now)).toContain("過去30日以内");
    expect(restoreTargetError(now, now)).toBe("今より前の日時を指定してください");
    expect(restoreTargetError(minutesAgo(-5), now)).toBe("今より前の日時を指定してください");
    expect(restoreTargetError(new Date(Number.NaN), now)).toBe("日時を正しく入力してください");
  });

  it("確認には、戻す日時を日本時間の秒まで入力してもらう", () => {
    const target = new Date("2026-11-02T00:15:30.400Z");
    expect(restoreConfirmationText(target)).toBe("2026-11-02 09:15:30");
    expect(confirmsRestore(target, " 2026-11-02 09:15:30 ")).toBe(true);
    expect(confirmsRestore(target, "2026-11-02 09:15")).toBe(false);
    expect(confirmsRestore(target, "")).toBe(false);
  });

  it("開発・テスト・検証のほかは本番として扱う", () => {
    expect(["development", "test", "staging"].map(isProductionLike)).toEqual([false, false, false]);
    expect(["production", "unconfigured", ""].map(isProductionLike)).toEqual([true, true, true]);
  });

  it("本番では RESTORE_UNLOCK_UNTIL が今から24時間以内の未来のときだけ開く", () => {
    expect(restoreLockError("staging", undefined, now)).toBeNull();
    expect(restoreLockError("production", undefined, now)).toContain(
      "運用担当が RESTORE_UNLOCK_UNTIL",
    );
    expect(restoreLockError("production", "  ", now)).toContain("運用担当が RESTORE_UNLOCK_UNTIL");
    expect(restoreLockError("production", "そのうち", now)).toContain("読めません");
    expect(restoreLockError("production", "2026-11-02T03:00:00Z", now)).toContain(
      "期限が過ぎています",
    );
    expect(restoreLockError("production", "2026-11-02T13:00:00+09:00", now)).toBeNull();
    expect(restoreLockError("unconfigured", "2026-11-03T03:00:00Z", now)).toBeNull();
    expect(restoreLockError("production", "2026-11-03T03:00:01Z", now)).toContain("24時間以内");
  });
});
