/** 取引先（要件定義書 3.3）。一覧・登録・編集・取引条件・取引終了・削除 */
import { Hono } from "hono";

import type { DomainError } from "../../../domain/result";
import { MAIN_CONTACT_LABELS } from "../../../usecases/masters/contact";
import type { PartnerRecord } from "../../../usecases/masters/partners.port";
import { bool, choice, formKey, int, intOrNull, readForm, str, type FormData_ } from "../../form";
import { NOTICES, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import {
  Alert,
  Badge,
  Checkbox,
  DescriptionList,
  EmptyState,
  ErrorSummary,
  Field,
  FormKey,
  Input,
  PageHeader,
  Pagination,
  Select,
  TextArea,
  toFormErrors,
  Version,
  type FormErrors,
} from "../../views/components";
import { postal } from "../../views/format";
import { Layout } from "../../views/layout";

export const partnerRoutes = new Hono<AppEnv>();

const MAIN_CONTACT_OPTIONS = Object.entries(MAIN_CONTACT_LABELS).map(([value, label]) => ({
  value,
  label,
}));
const SEND_METHOD_OPTIONS = [
  { value: "none", label: "送付しない（PDF をダウンロードして送る）" },
  { value: "email", label: "メール" },
];
const MONTH_OFFSET_OPTIONS = [
  { value: "0", label: "当月" },
  { value: "1", label: "翌月" },
  { value: "2", label: "翌々月" },
];
const DAY_OPTIONS = [
  ...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}日` })),
  { value: "31", label: "月末" },
];

type Values = Readonly<Record<string, string | boolean | number | null | undefined>>;

function partnerInputFromForm(form: FormData_) {
  return {
    name: str(form, "name"),
    kana: str(form, "kana"),
    honorific: choice(form, "honorific", ["御中", "様"] as const, "御中" as const),
    isSupplier: bool(form, "isSupplier"),
    isCustomer: bool(form, "isCustomer"),
    contactName: str(form, "contactName"),
    postalCode: str(form, "postalCode"),
    address: str(form, "address"),
    phone: str(form, "phone"),
    mobile: str(form, "mobile"),
    fax: str(form, "fax"),
    email: str(form, "email"),
    lineId: str(form, "lineId"),
    mainContact: choice(
      form,
      "mainContact",
      ["line", "email", "fax", "phone", "mobile"] as const,
      "" as const,
    ),
    deliveryDays: int(form, "deliveryDays"),
    defaultSendMethod: choice(
      form,
      "defaultSendMethod",
      ["email", "none"] as const,
      "none" as const,
    ),
    orderMethodNote: str(form, "orderMethodNote"),
    receiveMethodNote: str(form, "receiveMethodNote"),
    mailOrderAllowed: bool(form, "mailOrderAllowed"),
    placeName: str(form, "placeName"),
    memo: str(form, "memo"),
  };
}

function valuesFromRecord(p: PartnerRecord): Values {
  return { ...p };
}

function PartnerForm(props: {
  action: string;
  values: Values;
  errors: FormErrors;
  error?: DomainError | null;
  version?: number;
  submitLabel: string;
}) {
  const v = props.values;
  const s = (k: string) => {
    const x = v[k];
    return x === null || x === undefined ? "" : String(x);
  };
  return (
    <form
      method="post"
      action={props.action}
      hx-post={props.action}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
      data-draft={props.action}
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      {props.version !== undefined ? <Version value={props.version} /> : null}
      <fieldset>
        <legend>基本情報</legend>
        <div class="grid-2">
          <Field label="名称" name="name" required error={props.errors["name"]}>
            <Input name="name" value={s("name")} maxlength={100} />
          </Field>
          <Field
            label="読み仮名"
            name="kana"
            required
            error={props.errors["kana"]}
            hint="一覧の並び順と検索に使います"
          >
            <Input name="kana" value={s("kana")} maxlength={100} />
          </Field>
          <Field label="敬称（帳票に印字）" name="honorific" error={props.errors["honorific"]}>
            <Select
              name="honorific"
              value={s("honorific") || "御中"}
              options={[
                { value: "御中", label: "御中" },
                { value: "様", label: "様" },
              ]}
            />
          </Field>
          <Field label="区分" name="isSupplier" required error={props.errors["isSupplier"]}>
            <div class="inline">
              <Checkbox name="isSupplier" label="仕入先" checked={v["isSupplier"] === true} />
              <Checkbox name="isCustomer" label="販売先" checked={v["isCustomer"] === true} />
            </div>
          </Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>連絡先</legend>
        <div class="grid-2">
          <Field label="担当者名" name="contactName" error={props.errors["contactName"]}>
            <Input name="contactName" value={s("contactName")} />
          </Field>
          <Field label="郵便番号" name="postalCode" error={props.errors["postalCode"]}>
            <Input
              name="postalCode"
              value={s("postalCode")}
              inputmode="numeric"
              placeholder="022-0002"
            />
          </Field>
          <Field label="住所" name="address" error={props.errors["address"]}>
            <Input name="address" value={s("address")} />
          </Field>
          <Field label="電話" name="phone" error={props.errors["phone"]}>
            <Input name="phone" type="tel" value={s("phone")} placeholder="0192-22-1234" />
          </Field>
          <Field label="携帯" name="mobile" error={props.errors["mobile"]}>
            <Input name="mobile" type="tel" value={s("mobile")} />
          </Field>
          <Field label="FAX" name="fax" error={props.errors["fax"]}>
            <Input name="fax" type="tel" value={s("fax")} />
          </Field>
          <Field label="メール" name="email" error={props.errors["email"]}>
            <Input name="email" type="email" value={s("email")} />
          </Field>
          <Field label="LINE" name="lineId" error={props.errors["lineId"]}>
            <Input name="lineId" value={s("lineId")} />
          </Field>
          <Field label="主な連絡手段" name="mainContact" error={props.errors["mainContact"]}>
            <Select
              name="mainContact"
              value={s("mainContact")}
              options={MAIN_CONTACT_OPTIONS}
              empty="未選択"
            />
          </Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>取引の設定</legend>
        <div class="grid-2">
          <Field
            label="既定の送付方法"
            name="defaultSendMethod"
            error={props.errors["defaultSendMethod"]}
            hint="発注書・納品書・請求書を送る方法"
          >
            <Select
              name="defaultSendMethod"
              value={s("defaultSendMethod") || "none"}
              options={SEND_METHOD_OPTIONS}
            />
          </Field>
          <Field
            label="配送日数（販売先）"
            name="deliveryDays"
            error={props.errors["deliveryDays"]}
            hint="出荷予定日 = 納品希望日 − 配送日数"
          >
            <Input
              name="deliveryDays"
              type="number"
              min={0}
              max={30}
              value={s("deliveryDays") || "0"}
              inputmode="numeric"
            />
          </Field>
          <Field
            label="通常の発注方法（参考）"
            name="orderMethodNote"
            error={props.errors["orderMethodNote"]}
          >
            <Input name="orderMethodNote" value={s("orderMethodNote")} />
          </Field>
          <Field
            label="通常の受注方法（参考）"
            name="receiveMethodNote"
            error={props.errors["receiveMethodNote"]}
          >
            <Input name="receiveMethodNote" value={s("receiveMethodNote")} />
          </Field>
          <Field label="地名（参考）" name="placeName" error={props.errors["placeName"]}>
            <Input name="placeName" value={s("placeName")} />
          </Field>
          <Field label="通販掲載（参考）" name="mailOrderAllowed">
            <Checkbox
              name="mailOrderAllowed"
              label="通販への掲載を許可"
              checked={v["mailOrderAllowed"] === true}
            />
          </Field>
        </div>
        <Field label="備考" name="memo" error={props.errors["memo"]}>
          <TextArea name="memo" value={s("memo")} />
        </Field>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}

function roleBadges(p: PartnerRecord) {
  return (
    <>
      {p.isSupplier ? <Badge kind="info">仕入先</Badge> : null}{" "}
      {p.isCustomer ? <Badge kind="success">販売先</Badge> : null}{" "}
      {p.archived ? <Badge>取引終了</Badge> : null}
    </>
  );
}

function day(d: number): string {
  return d === 31 ? "月末" : `${d}日`;
}

function termsSummary(p: PartnerRecord): string {
  if (p.closingDay === null || p.paymentMonthOffset === null || p.paymentDay === null)
    return "設定なし（都度）";
  const month = ["当月", "翌月", "翌々月"][p.paymentMonthOffset] ?? "";
  return `${day(p.closingDay)}締め ${month}${day(p.paymentDay)}払い`;
}

// ---- 一覧 ---------------------------------------------------------------------

partnerRoutes.get("/", async (c) => {
  const q = c.req.query("q") ?? "";
  const roleParam = c.req.query("role");
  const role = roleParam === "supplier" || roleParam === "customer" ? roleParam : undefined;
  const includeArchived = c.req.query("archived") === "1";
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const result = await runQuery(c, "partners.list", {
    q,
    role,
    includeArchived,
    page,
    pageSize: 50,
  });
  const notice = NOTICES[c.req.query("notice") ?? ""];
  const href = (p: number) =>
    paths.partners({ q, role, archived: includeArchived ? 1 : undefined, page: p });
  const canManage = hasPermission(c.get("actor").roles, "partners.manage");
  return c.html(
    <Layout title="取引先" actor={c.get("actor")} current={paths.partners()}>
      <PageHeader
        title="取引先"
        actions={
          canManage ? (
            <a class="btn btn-primary" href={paths.partnerNew()}>
              取引先を登録
            </a>
          ) : null
        }
      />
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <form
        class="filters"
        method="get"
        action={paths.partners()}
        hx-get={paths.partners()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="input changed delay:300ms from:input[name=q], change"
      >
        <Field label="名称・読み仮名・電話で検索" name="q">
          <Input name="q" type="search" value={q} />
        </Field>
        <Field label="区分" name="role">
          <Select
            name="role"
            value={role ?? ""}
            empty="すべて"
            options={[
              { value: "supplier", label: "仕入先" },
              { value: "customer", label: "販売先" },
            ]}
          />
        </Field>
        <Checkbox name="archived" value="1" label="取引終了も表示" checked={includeArchived} />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        {result.rows.length === 0 ? (
          <EmptyState message="条件に合う取引先はありません" />
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>区分</th>
                <th>電話</th>
                <th>担当者</th>
                <th>取引条件</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((p) => (
                <tr>
                  <td>
                    <a href={paths.partner(p.id)}>{p.name}</a>
                    <div class="muted small">{p.kana}</div>
                  </td>
                  <td>{roleBadges(p)}</td>
                  <td>{p.phone ?? ""}</td>
                  <td>{p.contactName ?? ""}</td>
                  <td>{termsSummary(p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={result.page}
          pageSize={result.pageSize}
          total={result.total}
          href={href}
        />
      </section>
    </Layout>,
  );
});

// ---- 登録 ---------------------------------------------------------------------

partnerRoutes.get("/new", (c) =>
  c.html(
    <Layout title="取引先の登録" actor={c.get("actor")} current={paths.partners()}>
      <PageHeader title="取引先の登録" />
      <PartnerForm
        action={paths.partnerNew()}
        values={{ honorific: "御中", deliveryDays: 0, defaultSendMethod: "none" }}
        errors={{}}
        submitLabel="登録する"
      />
    </Layout>,
  ),
);

partnerRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const input = partnerInputFromForm(form);
  const result = await runCommand(c, "partners.create", input, formKey(form));
  if (result.ok) return redirectTo(c, `${paths.partner(result.value.id)}?notice=created`);
  return c.html(
    <PartnerForm
      action={paths.partnerNew()}
      values={input}
      errors={toFormErrors(result.error)}
      error={result.error}
      submitLabel="登録する"
    />,
  );
});

// ---- 詳細 ---------------------------------------------------------------------

partnerRoutes.get("/:id", async (c) => {
  const p = await runQuery(c, "partners.get", { id: c.req.param("id") });
  if (!p) return c.notFound();
  const actor = c.get("actor");
  const canManage = hasPermission(actor.roles, "partners.manage");
  const canTerms = hasPermission(actor.roles, "partners.terms");
  const notice = NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title={p.name} actor={actor} current={paths.partners()}>
      <PageHeader
        title={p.name}
        actions={
          canManage ? (
            <a class="btn btn-secondary" href={paths.partnerEdit(p.id)}>
              編集
            </a>
          ) : null
        }
      >
        <p>{roleBadges(p)}</p>
      </PageHeader>
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <section class="card">
        <h2>基本情報・連絡先</h2>
        <DescriptionList
          items={[
            ["読み仮名", p.kana],
            ["敬称", p.honorific],
            ["担当者名", p.contactName],
            [
              "住所",
              p.postalCode || p.address ? `${postal(p.postalCode)} ${p.address ?? ""}` : null,
            ],
            ["電話", p.phone],
            ["携帯", p.mobile],
            ["FAX", p.fax],
            ["メール", p.email],
            ["LINE", p.lineId],
            ["主な連絡手段", p.mainContact ? MAIN_CONTACT_LABELS[p.mainContact] : null],
            ["既定の送付方法", p.defaultSendMethod === "email" ? "メール" : "送付しない"],
            ["配送日数", `${p.deliveryDays}日`],
            ["通常の発注方法", p.orderMethodNote],
            ["通常の受注方法", p.receiveMethodNote],
            ["地名", p.placeName],
            ["通販掲載", p.mailOrderAllowed ? "許可" : "不可"],
            ["備考", p.memo ? <span class="pre">{p.memo}</span> : null],
          ]}
        />
      </section>
      <section class="card">
        <h2>取引条件・登録番号</h2>
        {canTerms ? (
          <TermsForm partner={p} errors={{}} />
        ) : (
          <DescriptionList
            items={[
              ["取引条件", termsSummary(p)],
              ["登録番号", p.registrationNumber],
            ]}
          />
        )}
      </section>
      {canManage ? (
        <section class="card">
          <h2>取引終了・削除</h2>
          <div class="inline">
            <form method="post" action={paths.partnerArchive(p.id)}>
              <FormKey />
              <Version value={p.version} />
              <input type="hidden" name="archived" value={p.archived ? "false" : "true"} />
              <button type="submit" class="btn btn-secondary">
                {p.archived ? "取引終了を取り消す" : "取引終了にする"}
              </button>
            </form>
            <form
              method="post"
              action={paths.partnerDelete(p.id)}
              hx-confirm={`「${p.name}」を削除します。取引で使われている場合は削除できません。よろしいですか？`}
            >
              <FormKey />
              <button type="submit" class="btn btn-danger">
                削除
              </button>
            </form>
          </div>
        </section>
      ) : null}
    </Layout>,
  );
});

function TermsForm(props: {
  partner: PartnerRecord;
  errors: FormErrors;
  error?: DomainError | null;
  values?: Values;
}) {
  const p = props.partner;
  const v: Values = props.values ?? {
    registrationNumber: p.registrationNumber,
    closingDay: p.closingDay,
    paymentMonthOffset: p.paymentMonthOffset,
    paymentDay: p.paymentDay,
  };
  const s = (k: string) => {
    const x = v[k];
    return x === null || x === undefined ? "" : String(x);
  };
  return (
    <form
      method="post"
      action={paths.partnerTerms(p.id)}
      hx-post={paths.partnerTerms(p.id)}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      <Version value={p.version} />
      <div class="grid-4">
        <Field label="締め日" name="closingDay" error={props.errors["terms.closingDay"]}>
          <Select
            name="closingDay"
            value={s("closingDay")}
            options={DAY_OPTIONS}
            empty="設定しない"
          />
        </Field>
        <Field label="支払月" name="paymentMonthOffset">
          <Select
            name="paymentMonthOffset"
            value={s("paymentMonthOffset")}
            options={MONTH_OFFSET_OPTIONS}
            empty="—"
          />
        </Field>
        <Field label="支払日" name="paymentDay">
          <Select name="paymentDay" value={s("paymentDay")} options={DAY_OPTIONS} empty="—" />
        </Field>
        <Field
          label="登録番号（インボイス）"
          name="registrationNumber"
          error={props.errors["terms.registrationNumber"]}
        >
          <Input
            name="registrationNumber"
            value={s("registrationNumber")}
            placeholder="T1234567890123"
          />
        </Field>
      </div>
      <p class="hint">
        締め日を設定すると、支払予定日・支払期限を自動で計算し、販売先は月締めで請求します。
      </p>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          取引条件を保存
        </button>
      </div>
    </form>
  );
}

partnerRoutes.post("/:id/terms", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const terms = {
    registrationNumber: str(form, "registrationNumber"),
    closingDay: intOrNull(form, "closingDay"),
    paymentMonthOffset: intOrNull(form, "paymentMonthOffset"),
    paymentDay: intOrNull(form, "paymentDay"),
  };
  const result = await runCommand(
    c,
    "partners.updateTerms",
    { id, version: int(form, "version"), terms },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, `${paths.partner(id)}?notice=updated`);
  const partner = await runQuery(c, "partners.get", { id });
  if (!partner) return c.notFound();
  return c.html(
    <TermsForm
      partner={partner}
      values={terms}
      errors={toFormErrors(result.error)}
      error={result.error}
    />,
  );
});

// ---- 編集 ---------------------------------------------------------------------

partnerRoutes.get("/:id/edit", async (c) => {
  const p = await runQuery(c, "partners.get", { id: c.req.param("id") });
  if (!p) return c.notFound();
  return c.html(
    <Layout title={`${p.name}の編集`} actor={c.get("actor")} current={paths.partners()}>
      <PageHeader title={`${p.name}の編集`} />
      <PartnerForm
        action={paths.partnerEdit(p.id)}
        values={valuesFromRecord(p)}
        errors={{}}
        version={p.version}
        submitLabel="保存する"
      />
    </Layout>,
  );
});

partnerRoutes.post("/:id/edit", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const fields = partnerInputFromForm(form);
  const version = int(form, "version");
  const result = await runCommand(c, "partners.update", { id, version, fields }, formKey(form));
  if (result.ok) return redirectTo(c, `${paths.partner(id)}?notice=updated`);
  return c.html(
    <PartnerForm
      action={paths.partnerEdit(id)}
      values={fields}
      errors={toFormErrors(result.error, "fields.")}
      error={result.error}
      version={version}
      submitLabel="保存する"
    />,
  );
});

// ---- 取引終了・削除 -------------------------------------------------------------

partnerRoutes.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const archived = str(form, "archived") === "true";
  const result = await runCommand(
    c,
    "partners.archive",
    { id, version: int(form, "version"), archived },
    formKey(form),
  );
  if (result.ok)
    return redirectTo(c, `${paths.partner(id)}?notice=${archived ? "archived" : "unarchived"}`);
  return c.text(result.error.message, 409);
});

partnerRoutes.post("/:id/delete", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(c, "partners.delete", { id }, formKey(form));
  if (result.ok) return redirectTo(c, `${paths.partners()}?notice=deleted`);
  return c.html(
    <Layout title="削除できません" actor={c.get("actor")} current={paths.partners()}>
      <Alert kind="error">{result.error.message}</Alert>
      <a href={paths.partner(id)}>取引先に戻る</a>
    </Layout>,
    409,
  );
});
