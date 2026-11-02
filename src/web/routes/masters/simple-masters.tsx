/** 名前と表示順だけのマスタ（ジャンル・払い出し先店舗：要件定義書 3.3）の一覧・登録・編集・取引終了 */
import { Hono } from "hono";

import type { DomainError } from "../../../domain/result";
import type { Permission } from "../../../domain/roles";
import { bool, formKey, int, readForm, str } from "../../form";
import { NOTICES, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import {
  Alert,
  Badge,
  Checkbox,
  EmptyState,
  ErrorSummary,
  Field,
  FormKey,
  Input,
  PageHeader,
  toFormErrors,
  Version,
  type FormErrors,
} from "../../views/components";
import { Layout } from "../../views/layout";

interface Spec {
  /** 画面に出す名前（「ジャンル」など） */
  readonly label: string;
  readonly hint: string;
  readonly permission: Permission;
  readonly names: {
    readonly create: "genres.create" | "retailStores.create";
    readonly update: "genres.update" | "retailStores.update";
    readonly archive: "genres.archive" | "retailStores.archive";
    readonly list: "genres.list" | "retailStores.list";
    readonly get: "genres.get" | "retailStores.get";
  };
  readonly paths: {
    readonly list: (query?: {
      archived?: number | undefined;
      notice?: string | undefined;
    }) => string;
    readonly create: () => string;
    readonly detail: (id: string) => string;
    readonly archive: (id: string) => string;
  };
}

function MasterForm(props: {
  action: string;
  label: string;
  values: { name: string; displayOrder: string };
  errors: FormErrors;
  error?: DomainError | null;
  version?: number;
  submitLabel: string;
}) {
  return (
    <form
      method="post"
      action={props.action}
      hx-post={props.action}
      hx-target="this"
      hx-swap="outerHTML"
      class="form card"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      {props.version !== undefined ? <Version value={props.version} /> : null}
      <div class="grid-2">
        <Field label="名前" name="name" required error={props.errors["name"]}>
          <Input name="name" value={props.values.name} maxlength={50} />
        </Field>
        <Field
          label="表示順"
          name="displayOrder"
          error={props.errors["displayOrder"]}
          hint="小さい順に選択肢に並びます"
        >
          <Input
            name="displayOrder"
            type="number"
            min={0}
            max={9999}
            inputmode="numeric"
            value={props.values.displayOrder}
          />
        </Field>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}

export function simpleMasterRoutes(spec: Spec): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const current = spec.paths.list();

  routes.get("/", async (c) => {
    const includeArchived = c.req.query("archived") === "1";
    const rows = await runQuery(c, spec.names.list, { includeArchived });
    const canManage = hasPermission(c.get("actor").roles, spec.permission);
    const notice = NOTICES[c.req.query("notice") ?? ""];
    return c.html(
      <Layout title={spec.label} actor={c.get("actor")} current={current}>
        <PageHeader
          title={spec.label}
          actions={
            canManage ? (
              <a class="btn btn-primary" href={spec.paths.create()}>
                {spec.label}を登録
              </a>
            ) : null
          }
        >
          <p class="hint">{spec.hint}</p>
        </PageHeader>
        {notice ? <Alert kind="success">{notice}</Alert> : null}
        <form
          class="filters"
          method="get"
          action={current}
          hx-get={current}
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
            <EmptyState message={`${spec.label}はまだ登録されていません`} />
          ) : (
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>名前</th>
                    <th class="num">表示順</th>
                    <th>状態</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr>
                      <td>
                        <a href={spec.paths.detail(r.id)}>{r.name}</a>
                      </td>
                      <td class="num">{r.displayOrder}</td>
                      <td>{r.archived ? <Badge>取引終了</Badge> : null}</td>
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

  routes.get("/new", (c) =>
    c.html(
      <Layout title={`${spec.label}の登録`} actor={c.get("actor")} current={current}>
        <PageHeader title={`${spec.label}の登録`} />
        <MasterForm
          action={spec.paths.create()}
          label={spec.label}
          values={{ name: "", displayOrder: "0" }}
          errors={{}}
          submitLabel="登録する"
        />
      </Layout>,
    ),
  );

  routes.post("/new", async (c) => {
    const form = await readForm(c);
    const input = { name: str(form, "name"), displayOrder: int(form, "displayOrder") };
    const result = await runCommand(c, spec.names.create, input, formKey(form));
    if (result.ok) return redirectTo(c, spec.paths.list({ notice: "created" }));
    return c.html(
      <MasterForm
        action={spec.paths.create()}
        label={spec.label}
        values={{ name: input.name, displayOrder: str(form, "displayOrder") }}
        errors={toFormErrors(result.error)}
        error={result.error}
        submitLabel="登録する"
      />,
    );
  });

  routes.get("/:id", async (c) => {
    const record = await runQuery(c, spec.names.get, { id: c.req.param("id") });
    if (!record) return c.notFound();
    const canManage = hasPermission(c.get("actor").roles, spec.permission);
    const notice = NOTICES[c.req.query("notice") ?? ""];
    return c.html(
      <Layout title={record.name} actor={c.get("actor")} current={current}>
        <PageHeader title={record.name}>
          <p>{record.archived ? <Badge>取引終了</Badge> : null}</p>
        </PageHeader>
        {notice ? <Alert kind="success">{notice}</Alert> : null}
        {canManage ? (
          <>
            <MasterForm
              action={spec.paths.detail(record.id)}
              label={spec.label}
              values={{ name: record.name, displayOrder: String(record.displayOrder) }}
              errors={{}}
              version={record.version}
              submitLabel="保存する"
            />
            <section class="card">
              <h2>取引終了</h2>
              <p class="hint">
                取引終了にすると、選択肢に出なくなります（これまでの記録は残ります）。
              </p>
              <form method="post" action={spec.paths.archive(record.id)}>
                <FormKey />
                <Version value={record.version} />
                <input type="hidden" name="archived" value={record.archived ? "false" : "true"} />
                <button type="submit" class="btn btn-secondary">
                  {record.archived ? "取引終了を取り消す" : "取引終了にする"}
                </button>
              </form>
            </section>
          </>
        ) : (
          <p>表示順：{record.displayOrder}</p>
        )}
      </Layout>,
    );
  });

  routes.post("/:id", async (c) => {
    const id = c.req.param("id");
    const form = await readForm(c);
    const version = int(form, "version");
    const fields = { name: str(form, "name"), displayOrder: int(form, "displayOrder") };
    const result = await runCommand(c, spec.names.update, { id, version, fields }, formKey(form));
    if (result.ok) return redirectTo(c, `${spec.paths.detail(id)}?notice=updated`);
    return c.html(
      <MasterForm
        action={spec.paths.detail(id)}
        label={spec.label}
        values={{ name: fields.name, displayOrder: str(form, "displayOrder") }}
        errors={toFormErrors(result.error, "fields.")}
        error={result.error}
        version={version}
        submitLabel="保存する"
      />,
    );
  });

  routes.post("/:id/archive", async (c) => {
    const id = c.req.param("id");
    const form = await readForm(c);
    const archived = bool(form, "archived");
    const result = await runCommand(
      c,
      spec.names.archive,
      { id, version: int(form, "version"), archived },
      formKey(form),
    );
    if (result.ok)
      return redirectTo(
        c,
        `${spec.paths.detail(id)}?notice=${archived ? "archived" : "unarchived"}`,
      );
    return c.html(
      <Layout title="変更できません" actor={c.get("actor")} current={current}>
        <Alert kind="error">{result.error.message}</Alert>
        <a href={spec.paths.detail(id)}>戻る</a>
      </Layout>,
      409,
    );
  });

  return routes;
}
