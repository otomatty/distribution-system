/** 入力検証で共通に使うスキーマ。 */
import { z } from "zod";

import { isBusinessDate } from "../domain/dates";

export const idSchema = z.string().min(1, "選択してください").max(64);
export const optionalText = (max = 2000) =>
  z
    .string()
    .max(max, `${max}文字以内で入力してください`)
    .transform((v) => (v.trim() === "" ? null : v.trim()))
    .nullable()
    .optional()
    .transform((v) => v ?? null);
export const requiredText = (max = 200) =>
  z.string().trim().min(1, "入力してください").max(max, `${max}文字以内で入力してください`);
export const businessDate = z.string().refine(isBusinessDate, "日付を正しく入力してください");
export const optionalBusinessDate = z
  .string()
  .optional()
  .nullable()
  .transform((v) => (v && v.trim() !== "" ? v : null))
  .refine((v) => v === null || isBusinessDate(v), "日付を正しく入力してください");
export const quantity = z
  .number()
  .int("整数で入力してください")
  .min(1, "1以上で入力してください")
  .max(9_999_999);
export const nonNegativeInt = z
  .number()
  .int("整数で入力してください")
  .min(0, "0以上で入力してください")
  .max(999_999_999);
export const yen = z
  .number()
  .int("円単位の整数で入力してください")
  .min(0, "0以上で入力してください")
  .max(9_999_999_999);
export const centi = z.number().int().min(0, "0以上で入力してください").max(99_999_999_999);
export const version = z.number().int().min(1);
export const taxCategory = z.enum(["standard", "reduced"]);
export const pageInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export interface Page<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
