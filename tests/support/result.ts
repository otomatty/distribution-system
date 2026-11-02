import type { DomainError, Result } from "../../src/domain/result";

/** 成功の値を取り出す。失敗ならテストを失敗させる */
export function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok but got error: ${r.error.code} ${r.error.message}`);
  return r.value;
}

/** 失敗の内容を取り出す。成功ならテストを失敗させる */
export function unwrapErr<T>(r: Result<T>): DomainError {
  if (r.ok) throw new Error("expected error but got ok");
  return r.error;
}
