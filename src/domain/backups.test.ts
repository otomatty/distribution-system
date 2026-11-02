import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { expiredBackupDates } from "./backups";
import { addDays } from "./dates";

describe("backups", () => {
  it("直近30日は毎日の分を残し、それより前は月初の分を7年残す", () => {
    const today = "2026-11-02";
    const dates = [
      "2026-11-02",
      "2026-10-03", // 30日前：残す
      "2026-10-02", // 31日前：消す
      "2026-10-01", // 月初：残す
      "2019-11-02", // 7年前の月初以外：消す
      "2019-12-01", // 7年以内の月初：残す
      "2019-11-01", // 7年より前の月初：消す
      "not-a-date",
    ];
    expect(expiredBackupDates(dates, today)).toEqual(["2026-10-02", "2019-11-02", "2019-11-01"]);
  });

  it("直近30日のものは消さない（どの日付でも）", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00Z"),
          max: new Date("2099-12-31T00:00:00Z"),
          noInvalidDate: true,
        }),
        fc.integer({ min: 0, max: 30 }),
        (d, back) => {
          const today = d.toISOString().slice(0, 10);
          expect(expiredBackupDates([addDays(today, -back)], today)).toEqual([]);
        },
      ),
      { seed: 20261102 },
    );
  });
});
