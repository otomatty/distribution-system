/** フォームの値を、ユースケースの入力に変換するヘルパー。検証はユースケース側（zod）で行う。 */
import type { Context } from "hono";

import { parseYenToCenti } from "../domain/money";
import type { AppEnv } from "./types";

export type FormData_ = Record<string, string | string[]>;

export async function readForm(c: Context<AppEnv>): Promise<FormData_> {
  const body = await c.req.parseBody({ all: true });
  const out: FormData_ = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
  }
  return out;
}

export function str(form: FormData_, name: string): string {
  const v = form[name];
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "";
}

export function strs(form: FormData_, name: string): string[] {
  const v = form[name];
  return typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
}

/** 未入力は null、数字でなければ NaN（ユースケースの検証でエラーになる） */
export function intOrNull(form: FormData_, name: string): number | null {
  const t = str(form, name).replaceAll(",", "").trim();
  if (t === "") return null;
  return /^-?\d+$/.test(t) ? Number(t) : Number.NaN;
}

export function int(form: FormData_, name: string, fallback = 0): number {
  return intOrNull(form, name) ?? fallback;
}

/** 選択肢のどれかなら、その値。どれでもなければ fallback */
export function choice<T extends string, F>(
  form: FormData_,
  name: string,
  allowed: readonly T[],
  fallback: F,
): T | F {
  const v = str(form, name);
  return allowed.find((a) => a === v) ?? fallback;
}

export function bool(form: FormData_, name: string): boolean {
  const v = str(form, name);
  return v === "on" || v === "true" || v === "1";
}

/** 「1234.56」形式の円を centi-yen に。不正なら NaN */
export function centi(form: FormData_, name: string): number {
  const t = str(form, name).trim();
  if (t === "") return Number.NaN;
  return parseYenToCenti(t) ?? Number.NaN;
}

/**
 * 受付番号（冪等キー）。フォームの描画時に埋め込み、再送信でも同じ値を送る。
 * 送られていなければ空の文字列を返し、業務 DB が操作を受け付けない（画面からの操作には必須）
 */
export function formKey(form: FormData_): string {
  return str(form, "_key");
}

export function newFormKey(): string {
  return crypto.randomUUID();
}
