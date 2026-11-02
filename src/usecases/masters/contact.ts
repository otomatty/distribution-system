/** 連絡先一式の入力スキーマ（取引先・保管場所・自社で共通）。 */
import { z } from "zod";

import { isValidEmail, normalizePhone, normalizePostalCode } from "../../domain/validation";
import { optionalText } from "../schemas";

function normalized(normalize: (text: string) => string | undefined, message: string) {
  return z
    .string()
    .optional()
    .nullable()
    .transform((value, ctx) => {
      const t = (value ?? "").trim();
      if (t === "") return null;
      const n = normalize(t);
      if (n === undefined) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return n;
    });
}

export const postalCodeInput = normalized(
  normalizePostalCode,
  "郵便番号は7桁の数字で入力してください",
);
export const phoneInput = normalized(
  normalizePhone,
  "電話番号の形式が正しくありません（例：0192-22-1234）",
);
export const faxInput = normalized(
  normalizePhone,
  "FAX 番号の形式が正しくありません（例：0192-22-1234）",
);
export const emailInput = normalized(
  (t) => (isValidEmail(t) ? t.toLowerCase() : undefined),
  "メールアドレスの形式が正しくありません",
);

export const mainContactInput = z
  .enum(["line", "email", "fax", "phone", "mobile", ""])
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

export const contactInput = {
  contactName: optionalText(100),
  postalCode: postalCodeInput,
  address: optionalText(200),
  phone: phoneInput,
  mobile: phoneInput,
  fax: faxInput,
  email: emailInput,
  lineId: optionalText(100),
  mainContact: mainContactInput,
};

export const MAIN_CONTACT_LABELS = {
  line: "LINE",
  email: "メール",
  fax: "FAX",
  phone: "電話",
  mobile: "携帯",
} as const;
