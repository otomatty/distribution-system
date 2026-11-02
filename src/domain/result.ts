/** 業務処理の結果。業務エラーは例外にせず、この型で返す（AGENTS.md 4章）。 */
export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type DomainErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "unauthenticated"
  | "conflict"
  | "invalid_state"
  | "insufficient_stock"
  | "duplicate";

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly fields?: readonly FieldError[];
  readonly details?: readonly string[];
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err(
  code: DomainErrorCode,
  message: string,
  extra: { fields?: readonly FieldError[]; details?: readonly string[] } = {},
): Result<never> {
  return { ok: false, error: { code, message, ...extra } };
}
