/** 入力値の形式チェック（純粋関数）。 */

/** JAN（8桁または13桁）のチェックディジットを検証する。 */
export function isValidJan(code: string): boolean {
  if (!/^(\d{8}|\d{13})$/.test(code)) return false;
  const digits = Array.from(code, Number);
  const check = digits.pop();
  let sum = 0;
  // 右から数えて奇数桁（チェックディジットを除く）に3を掛ける
  digits.toReversed().forEach((d, i) => {
    sum += i % 2 === 0 ? d * 3 : d;
  });
  return (10 - (sum % 10)) % 10 === check;
}

/** 郵便番号を「1234567」に正規化する。不正なら undefined。 */
export function normalizePostalCode(text: string): string | undefined {
  const t = text.replace(/[‐－\-ー\s]/g, "");
  return /^\d{7}$/.test(t) ? t : undefined;
}

export function formatPostalCode(code: string): string {
  return /^\d{7}$/.test(code) ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

/** 電話・FAX 番号（国内、10〜11桁、ハイフン可）。正規化した文字列を返す。 */
export function normalizePhone(text: string): string | undefined {
  const t = text.replace(/[‐－ー\s]/g, "-").trim();
  if (!/^0[\d-]+$/.test(t)) return undefined;
  const digits = t.replaceAll("-", "");
  return /^0\d{9,10}$/.test(digits) ? t : undefined;
}

/** 適格請求書発行事業者の登録番号（T + 13桁）。 */
export function normalizeRegistrationNumber(text: string): string | undefined {
  const t = text.trim().toUpperCase();
  return /^T\d{13}$/.test(t) ? t : undefined;
}

export function isValidEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}
