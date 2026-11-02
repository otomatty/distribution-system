/** 設定（要件定義書 3.1）。管理者だけが使う。自社情報・端数処理・税率表 */
import { Hono } from "hono";

import { formatRate, ROUNDING_MODE_LABELS, TAX_CATEGORY_LABELS } from "../../../domain/money";
import type { DomainError } from "../../../domain/result";
import { choice, formKey, int, readForm, str, type FormData_ } from "../../form";
import { NOTICES, redirectTo } from "../../http";
import { requirePermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import {
  Alert,
  Badge,
  ErrorSummary,
  Field,
  FormKey,
  Input,
  PageHeader,
  Select,
  TextArea,
  toFormErrors,
  Version,
  type FormErrors,
} from "../../views/components";
import { Layout } from "../../views/layout";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.use("*", requirePermission("settings.manage"));

const ROUNDING_OPTIONS = Object.entries(ROUNDING_MODE_LABELS).map(([value, label]) => ({
  value,
  label,
}));
const CATEGORY_OPTIONS = Object.entries(TAX_CATEGORY_LABELS).map(([value, label]) => ({
  value,
  label,
}));
const SETTINGS_NOTICES: Readonly<Record<string, string>> = {
  ...NOTICES,
  taxRateAdded: "税率を追加しました",
};

type Values = Readonly<Record<string, string | number | null | undefined>>;

function companyInputFromForm(form: FormData_) {
  return {
    version: int(form, "version"),
    name: str(form, "name"),
    registrationNumber: str(form, "registrationNumber"),
    postalCode: str(form, "postalCode"),
    address: str(form, "address"),
    phone: str(form, "phone"),
    fax: str(form, "fax"),
    email: str(form, "email"),
    bankInfo: str(form, "bankInfo"),
    roundingMode: choice(
      form,
      "roundingMode",
      ["floor", "round", "ceil"] as const,
      "floor" as const,
    ),
  };
}

function CompanyForm(props: {
  values: Values;
  version: number;
  errors: FormErrors;
  error?: DomainError | null;
}) {
  const s = (k: string) => {
    const x = props.values[k];
    return x === null || x === undefined ? "" : String(x);
  };
  const e = props.errors;
  return (
    <form
      method="post"
      action={paths.settingsCompany()}
      hx-post={paths.settingsCompany()}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
      id="company-form"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      <Version value={props.version} />
      <fieldset>
        <legend>自社情報（帳票に印字）</legend>
        <div class="grid-2">
          <Field label="名称" name="name" required error={e["name"]}>
            <Input name="name" value={s("name")} maxlength={100} />
          </Field>
          <Field
            label="登録番号（インボイス）"
            name="registrationNumber"
            error={e["registrationNumber"]}
            hint="T と13桁の数字"
          >
            <Input
              name="registrationNumber"
              value={s("registrationNumber")}
              placeholder="T1234567890123"
            />
          </Field>
          <Field label="郵便番号" name="postalCode" error={e["postalCode"]}>
            <Input name="postalCode" value={s("postalCode")} inputmode="numeric" />
          </Field>
          <Field label="住所" name="address" error={e["address"]}>
            <Input name="address" value={s("address")} />
          </Field>
          <Field label="電話" name="phone" error={e["phone"]}>
            <Input name="phone" type="tel" value={s("phone")} />
          </Field>
          <Field label="FAX" name="fax" error={e["fax"]}>
            <Input name="fax" type="tel" value={s("fax")} />
          </Field>
          <Field label="メール" name="email" error={e["email"]}>
            <Input name="email" type="email" value={s("email")} />
          </Field>
        </div>
        <Field label="振込先" name="bankInfo" error={e["bankInfo"]} hint="請求書に印字します">
          <TextArea name="bankInfo" value={s("bankInfo")} />
        </Field>
      </fieldset>
      <fieldset>
        <legend>消費税の端数処理</legend>
        <Field
          label="端数処理の方法"
          name="roundingMode"
          error={e["roundingMode"]}
          hint="明細の金額（単価 × 数量）と、請求書ごと・税率ごとの消費税に使います"
        >
          <Select
            name="roundingMode"
            value={s("roundingMode") || "floor"}
            options={ROUNDING_OPTIONS}
          />
        </Field>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          保存する
        </button>
      </div>
    </form>
  );
}

function TaxRateForm(props: { values: Values; errors: FormErrors; error?: DomainError | null }) {
  const s = (k: string) => {
    const x = props.values[k];
    return x === null || x === undefined ? "" : String(x);
  };
  return (
    <form
      method="post"
      action={paths.settingsTaxRates()}
      hx-post={paths.settingsTaxRates()}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
      id="tax-rate-form"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      <div class="grid-3">
        <Field label="税区分" name="category" required error={props.errors["category"]}>
          <Select name="category" value={s("category") || "standard"} options={CATEGORY_OPTIONS} />
        </Field>
        <Field label="税率（%）" name="ratePercent" required error={props.errors["ratePercent"]}>
          <Input name="ratePercent" value={s("ratePercent")} inputmode="decimal" placeholder="10" />
        </Field>
        <Field
          label="適用開始日"
          name="effectiveFrom"
          required
          error={props.errors["effectiveFrom"]}
        >
          <Input name="effectiveFrom" type="date" value={s("effectiveFrom")} />
        </Field>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          税率を追加
        </button>
      </div>
    </form>
  );
}

settingsRoutes.get("/", async (c) => {
  const settings = await runQuery(c, "settings.get", {});
  const notice = SETTINGS_NOTICES[c.req.query("notice") ?? ""];
  const active = new Set(settings.activeTaxRateIds);
  return c.html(
    <Layout title="設定" actor={c.get("actor")} current={paths.settings()}>
      <PageHeader title="設定" />
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <section class="card">
        <h2>自社情報・端数処理</h2>
        <CompanyForm
          values={{ ...settings.company }}
          version={settings.company.version}
          errors={{}}
        />
      </section>
      <section class="card">
        <h2>税率表</h2>
        <p class="hint">
          取引日の時点で適用開始日が最も新しい税率を使います。登録した税率は変更できません。
        </p>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>税区分</th>
                <th class="num">税率</th>
                <th>適用開始日</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {settings.taxRates.map((r) => (
                <tr>
                  <td>{TAX_CATEGORY_LABELS[r.category]}</td>
                  <td class="num">{formatRate(r.rateBps)}</td>
                  <td>{r.effectiveFrom}</td>
                  <td>{active.has(r.id) ? <Badge kind="success">適用中</Badge> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>税率を追加する</h3>
        <TaxRateForm values={{}} errors={{}} />
      </section>
    </Layout>,
  );
});

settingsRoutes.post("/company", async (c) => {
  const form = await readForm(c);
  const input = companyInputFromForm(form);
  const result = await runCommand(c, "settings.updateCompany", input, formKey(form));
  if (result.ok) return redirectTo(c, paths.settings({ notice: "updated" }));
  return c.html(
    <CompanyForm
      values={input}
      version={input.version}
      errors={toFormErrors(result.error)}
      error={result.error}
    />,
  );
});

/** 「10」「8」「10.5」の形の税率。数字でなければ NaN（ユースケースの検証でエラーになる） */
function percent(form: FormData_, name: string): number {
  const t = str(form, name).trim();
  return /^\d{1,3}(\.\d{1,2})?$/.test(t) ? Number(t) : Number.NaN;
}

settingsRoutes.post("/tax-rates", async (c) => {
  const form = await readForm(c);
  const input = {
    category: choice(form, "category", ["standard", "reduced"] as const, "standard" as const),
    ratePercent: percent(form, "ratePercent"),
    effectiveFrom: str(form, "effectiveFrom"),
  };
  const result = await runCommand(c, "settings.addTaxRate", input, formKey(form));
  if (result.ok) return redirectTo(c, paths.settings({ notice: "taxRateAdded" }));
  return c.html(
    <TaxRateForm
      values={{
        category: str(form, "category"),
        ratePercent: str(form, "ratePercent"),
        effectiveFrom: input.effectiveFrom,
      }}
      errors={toFormErrors(result.error)}
      error={result.error}
    />,
  );
});
