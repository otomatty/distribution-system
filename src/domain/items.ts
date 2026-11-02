/** 商品マスタのルール（要件定義書 3.2）。 */

export const TEMPERATURE_ZONES = ["ambient", "chilled", "frozen"] as const;
export type TemperatureZone = (typeof TEMPERATURE_ZONES)[number];

export const TEMPERATURE_ZONE_LABELS: Readonly<Record<TemperatureZone, string>> = {
  ambient: "常温",
  chilled: "冷蔵",
  frozen: "冷凍",
};

/** 商品コード：英数字・ハイフン・下線の30文字以内（ライブレジのコードとそろえる） */
export function isValidItemCode(code: string): boolean {
  return /^[0-9A-Za-z_-]{1,30}$/.test(code);
}

/**
 * 自動採番の候補から、まだ使われていないコードを選ぶ。
 * 手で入力したコードが採番の形式と重なっていても、空いている番号まで進める。
 */
export function firstFreeCode(
  candidates: Iterable<string>,
  isTaken: (code: string) => boolean,
  maxTries = 1000,
): string | undefined {
  let tries = 0;
  for (const code of candidates) {
    if (!isTaken(code)) return code;
    tries += 1;
    if (tries >= maxTries) return undefined;
  }
  return undefined;
}
