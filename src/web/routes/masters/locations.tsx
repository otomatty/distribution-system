/** 保管場所（要件定義書 3.3）。在庫を置く場所。一覧・登録・編集・取引終了 */
import { Hono } from "hono";

import type { DomainError } from "../../../domain/result";
import { MAIN_CONTACT_LABELS } from "../../../usecases/masters/contact";
import type { LocationRecord } from "../../../usecases/masters/locations.port";
import { bool, choice, formKey, int, readForm, str, type FormData_ } from "../../form";
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
  Select,
  TextArea,
  toFormErrors,
  Version,
  type FormErrors,
} from "../../views/components";
import { postal } from "../../views/format";
import { Layout } from "../../views/layout";

export const locationRoutes = new Hono<AppEnv>();

const MAIN_CONTACT_OPTIONS = Object.entries(MAIN_CONTACT_LABELS).map(([value, label]) => ({
  value,
  label,
}));

type Values = Readonly<Record<string, string | number | boolean | null | undefined>>;

function inputFromForm(form: FormData_) {
  return {
    name: str(form, "name"),
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
    memo: str(form, "memo"),
    displayOrder: int(form, "displayOrder"),
  };
}

function LocationForm(props: {
  action: string;
  values: Values;
  errors: FormErrors;
  error?: DomainError | null;
  version?: number;
  submitLabel: string;
}) {
  const s = (k: string) => {
    const x = props.values[k];
    return x === null || x === undefined ? "" : String(x);
  };
  const e = props.errors;
  return (
    <form
      method="post"
      action={props.action}
      hx-post={props.action}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      {props.version !== undefined ? <Version value={props.version} /> : null}
      <fieldset>
        <legend>保管場所</legend>
        <div class="grid-2">
          <Field label="名前" name="name" required error={e["name"]}>
            <Input name="name" value={s("name")} maxlength={50} />
          </Field>
          <Field label="表示順" name="displayOrder" error={e["displayOrder"]}>
            <Input
              name="displayOrder"
              type="number"
              min={0}
              max={9999}
              inputmode="numeric"
              value={s("displayOrder") || "0"}
            />
          </Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>連絡先</legend>
        <div class="grid-2">
          <Field label="担当者名" name="contactName" error={e["contactName"]}>
            <Input name="contactName" value={s("contactName")} />
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
          <Field label="携帯" name="mobile" error={e["mobile"]}>
            <Input name="mobile" type="tel" value={s("mobile")} />
          </Field>
          <Field label="FAX" name="fax" error={e["fax"]}>
            <Input name="fax" type="tel" value={s("fax")} />
          </Field>
          <Field label="メール" name="email" error={e["email"]}>
            <Input name="email" type="email" value={s("email")} />
          </Field>
          <Field label="LINE" name="lineId" error={e["lineId"]}>
            <Input name="lineId" value={s("lineId")} />
          </Field>
          <Field label="主な連絡手段" name="mainContact" error={e["mainContact"]}>
            <Select
              name="mainContact"
              value={s("mainContact")}
              options={MAIN_CONTACT_OPTIONS}
              empty="未選択"
            />
          </Field>
        </div>
        <Field label="備考" name="memo" error={e["memo"]}>
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

function contactSummary(l: LocationRecord) {
  return [
    ["担当者名", l.contactName],
    ["住所", l.postalCode || l.address ? `${postal(l.postalCode)} ${l.address ?? ""}` : null],
    ["電話", l.phone],
    ["携帯", l.mobile],
    ["FAX", l.fax],
    ["メール", l.email],
    ["LINE", l.lineId],
    ["主な連絡手段", l.mainContact ? MAIN_CONTACT_LABELS[l.mainContact] : null],
    ["備考", l.memo ? <span class="pre">{l.memo}</span> : null],
  ] as const;
}

locationRoutes.get("/", async (c) => {
  const includeArchived = c.req.query("archived") === "1";
  const rows = await runQuery(c, "locations.list", { includeArchived });
  const canManage = hasPermission(c.get("actor").roles, "locations.manage");
  const notice = NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title="保管場所" actor={c.get("actor")} current={paths.locations()}>
      <PageHeader
        title="保管場所"
        actions={
          canManage ? (
            <a class="btn btn-primary" href={paths.locationNew()}>
              保管場所を登録
            </a>
          ) : null
        }
      >
        <p class="hint">在庫を置く場所（倉庫など）。発注の納入先と受注の出荷元に使います。</p>
      </PageHeader>
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <form
        class="filters"
        method="get"
        action={paths.locations()}
        hx-get={paths.locations()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Checkbox name="archived" value="1" label="取引終了も表示" checked={includeArchived} />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            表示
          </button>
        </noscript>
      </form>
      <section id="results">
        {rows.length === 0 ? (
          <EmptyState message="保管場所はまだ登録されていません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>名前</th>
                  <th>住所</th>
                  <th>電話</th>
                  <th class="num">表示順</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr>
                    <td>
                      <a href={paths.location(l.id)}>{l.name}</a>
                    </td>
                    <td>{l.address ?? ""}</td>
                    <td>{l.phone ?? ""}</td>
                    <td class="num">{l.displayOrder}</td>
                    <td>{l.archived ? <Badge>取引終了</Badge> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Layout>,
  );
});

locationRoutes.get("/new", (c) =>
  c.html(
    <Layout title="保管場所の登録" actor={c.get("actor")} current={paths.locations()}>
      <PageHeader title="保管場所の登録" />
      <LocationForm
        action={paths.locationNew()}
        values={{ displayOrder: 0 }}
        errors={{}}
        submitLabel="登録する"
      />
    </Layout>,
  ),
);

locationRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const input = inputFromForm(form);
  const result = await runCommand(c, "locations.create", input, formKey(form));
  if (result.ok) return redirectTo(c, paths.locations({ notice: "created" }));
  return c.html(
    <LocationForm
      action={paths.locationNew()}
      values={{ ...input, displayOrder: str(form, "displayOrder") }}
      errors={toFormErrors(result.error)}
      error={result.error}
      submitLabel="登録する"
    />,
  );
});

/** 詳細：管理者には編集フォーム、それ以外の人には内容を表示する */
locationRoutes.get("/:id", async (c) => {
  const l = await runQuery(c, "locations.get", { id: c.req.param("id") });
  if (!l) return c.notFound();
  const canManage = hasPermission(c.get("actor").roles, "locations.manage");
  const notice = NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title={l.name} actor={c.get("actor")} current={paths.locations()}>
      <PageHeader
        title={l.name}
        actions={
          <a class="btn btn-secondary" href={paths.stock({ locationId: l.id })}>
            この保管場所の在庫
          </a>
        }
      >
        <p>{l.archived ? <Badge>取引終了</Badge> : null}</p>
      </PageHeader>
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {canManage ? (
        <>
          <LocationForm
            action={paths.location(l.id)}
            values={{ ...l }}
            errors={{}}
            version={l.version}
            submitLabel="保存する"
          />
          <section class="card">
            <h2>取引終了</h2>
            <p class="hint">
              取引終了にすると、発注・受注・在庫操作の選択肢に出なくなります（在庫の記録は残ります）。
            </p>
            <form method="post" action={paths.locationArchive(l.id)}>
              <FormKey />
              <Version value={l.version} />
              <input type="hidden" name="archived" value={l.archived ? "false" : "true"} />
              <button type="submit" class="btn btn-secondary">
                {l.archived ? "取引終了を取り消す" : "取引終了にする"}
              </button>
            </form>
          </section>
        </>
      ) : (
        <section class="card">
          <DescriptionList items={contactSummary(l)} />
        </section>
      )}
    </Layout>,
  );
});

locationRoutes.post("/:id", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const version = int(form, "version");
  const fields = inputFromForm(form);
  const result = await runCommand(c, "locations.update", { id, version, fields }, formKey(form));
  if (result.ok) return redirectTo(c, paths.location(id, { notice: "updated" }));
  return c.html(
    <LocationForm
      action={paths.location(id)}
      values={{ ...fields, displayOrder: str(form, "displayOrder") }}
      errors={toFormErrors(result.error, "fields.")}
      error={result.error}
      version={version}
      submitLabel="保存する"
    />,
  );
});

locationRoutes.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const archived = bool(form, "archived");
  const result = await runCommand(
    c,
    "locations.archive",
    { id, version: int(form, "version"), archived },
    formKey(form),
  );
  if (result.ok)
    return redirectTo(c, paths.location(id, { notice: archived ? "archived" : "unarchived" }));
  return c.html(
    <Layout title="変更できません" actor={c.get("actor")} current={paths.locations()}>
      <Alert kind="error">{result.error.message}</Alert>
      <a href={paths.location(id)}>戻る</a>
    </Layout>,
    409,
  );
});
