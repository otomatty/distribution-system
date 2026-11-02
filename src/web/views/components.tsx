/** 画面の部品。フォームの部品はエラー表示とタブレット向けの大きさに対応する。 */
import type { Child, PropsWithChildren } from "hono/jsx";

import type { DomainError } from "../../domain/result";
import { newFormKey } from "../form";

export type FormErrors = Readonly<Record<string, string>>;

/** ユースケースのエラーを、項目ごとのエラーに変換する */
export function toFormErrors(error: DomainError, prefix = ""): FormErrors {
  const out: Record<string, string> = {};
  for (const f of error.fields ?? []) {
    const key = prefix && f.field.startsWith(prefix) ? f.field.slice(prefix.length) : f.field;
    out[key] ??= f.message;
  }
  return out;
}

export function PageHeader(props: { title: string; actions?: Child; children?: Child }) {
  return (
    <div class="page-header">
      <div>
        <h1>{props.title}</h1>
        {props.children}
      </div>
      {props.actions ? <div class="page-actions">{props.actions}</div> : null}
    </div>
  );
}

export function Alert(
  props: PropsWithChildren<{ kind?: "error" | "success" | "warning" | "info"; id?: string }>,
) {
  return (
    <div
      class={`alert alert-${props.kind ?? "info"}`}
      role={props.kind === "error" ? "alert" : "status"}
      id={props.id}
    >
      {props.children}
    </div>
  );
}

/** フォーム全体のエラー（項目に結びつかないもの）と、項目エラーの件数 */
export function ErrorSummary(props: { error?: DomainError | null | undefined }) {
  const e = props.error;
  if (!e) return null;
  return (
    <Alert kind="error">
      <strong>{e.message}</strong>
      {e.details && e.details.length > 0 ? (
        <ul>
          {e.details.map((d) => (
            <li>{d}</li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

export function Field(
  props: PropsWithChildren<{
    label: string;
    name: string;
    error?: string | undefined;
    hint?: string;
    required?: boolean;
  }>,
) {
  return (
    <div class={props.error ? "field has-error" : "field"}>
      <label for={`f-${props.name}`}>
        {props.label}
        {props.required ? <span class="required">必須</span> : null}
      </label>
      {props.children}
      {props.hint ? <p class="hint">{props.hint}</p> : null}
      {props.error ? (
        <p class="field-error" id={`e-${props.name}`}>
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

type InputProps = {
  name: string;
  value?: string | number | null | undefined;
  type?: "text" | "email" | "date" | "number" | "tel" | "search" | "month";
  error?: string | undefined;
  placeholder?: string;
  required?: boolean;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  maxlength?: number;
  inputmode?: "numeric" | "decimal" | "tel" | "email" | "text";
  autofocus?: boolean;
  readonly?: boolean;
  list?: string;
};

export function Input(props: InputProps) {
  return (
    <input
      id={`f-${props.name}`}
      name={props.name}
      type={props.type ?? "text"}
      value={props.value === null || props.value === undefined ? "" : String(props.value)}
      placeholder={props.placeholder}
      required={props.required}
      min={props.min}
      max={props.max}
      step={props.step}
      maxlength={props.maxlength}
      inputmode={props.inputmode}
      autofocus={props.autofocus}
      readonly={props.readonly}
      list={props.list}
      aria-invalid={props.error ? "true" : undefined}
      aria-describedby={props.error ? `e-${props.name}` : undefined}
    />
  );
}

export function TextArea(props: {
  name: string;
  value?: string | null | undefined;
  rows?: number;
  error?: string | undefined;
}) {
  return (
    <textarea
      id={`f-${props.name}`}
      name={props.name}
      rows={props.rows ?? 3}
      aria-invalid={props.error ? "true" : undefined}
    >
      {props.value ?? ""}
    </textarea>
  );
}

export interface Option {
  readonly value: string;
  readonly label: string;
}

export function Select(props: {
  name: string;
  options: readonly Option[];
  value?: string | null | undefined;
  empty?: string;
  error?: string | undefined;
  required?: boolean;
}) {
  return (
    <select
      id={`f-${props.name}`}
      name={props.name}
      required={props.required}
      aria-invalid={props.error ? "true" : undefined}
    >
      {props.empty !== undefined ? <option value="">{props.empty}</option> : null}
      {props.options.map((o) => (
        <option value={o.value} selected={o.value === (props.value ?? "")}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox(props: {
  name: string;
  label: string;
  checked?: boolean | undefined;
  value?: string;
}) {
  return (
    <label class="checkbox">
      <input
        type="checkbox"
        name={props.name}
        value={props.value ?? "on"}
        checked={props.checked}
      />{" "}
      {props.label}
    </label>
  );
}

/** 受付番号（冪等キー）。再送信でも同じ値が送られるよう、描画時に1回だけ作る */
export function FormKey(props: { value?: string | undefined }) {
  return <input type="hidden" name="_key" value={props.value ?? newFormKey()} />;
}

export function Version(props: { value: number }) {
  return <input type="hidden" name="version" value={String(props.value)} />;
}

export function Badge(
  props: PropsWithChildren<{ kind?: "neutral" | "info" | "success" | "warning" | "danger" }>,
) {
  return <span class={`badge badge-${props.kind ?? "neutral"}`}>{props.children}</span>;
}

export function EmptyState(props: { message: string; action?: Child }) {
  return (
    <div class="empty">
      <p>{props.message}</p>
      {props.action}
    </div>
  );
}

export function Pagination(props: {
  page: number;
  pageSize: number;
  total: number;
  href: (page: number) => string;
  target?: string;
}) {
  const pages = Math.max(1, Math.ceil(props.total / props.pageSize));
  if (pages <= 1) return <p class="muted">{props.total}件</p>;
  const link = (p: number, label: string, disabled: boolean) =>
    disabled ? (
      <span class="btn btn-secondary btn-sm" aria-disabled="true">
        {label}
      </span>
    ) : (
      <a
        class="btn btn-secondary btn-sm"
        href={props.href(p)}
        hx-get={props.href(p)}
        hx-target={props.target ?? "#results"}
        hx-select={props.target ?? "#results"}
        hx-swap="outerHTML"
        hx-push-url="true"
      >
        {label}
      </a>
    );
  return (
    <nav class="pagination" aria-label="ページ">
      {link(props.page - 1, "前へ", props.page <= 1)}
      <span class="muted">
        {props.page} / {pages}ページ（{props.total}件）
      </span>
      {link(props.page + 1, "次へ", props.page >= pages)}
    </nav>
  );
}

export function DescriptionList(props: { items: readonly (readonly [string, Child])[] }) {
  return (
    <dl class="desc">
      {props.items.map(([k, v]) => (
        <>
          <dt>{k}</dt>
          <dd>{v === null || v === undefined || v === "" ? <span class="muted">—</span> : v}</dd>
        </>
      ))}
    </dl>
  );
}
