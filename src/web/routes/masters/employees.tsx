/** 社員管理（要件定義書 2章）。管理者だけが使う。登録・役割の変更・無効化（削除はしない） */
import { Hono } from "hono";

import type { DomainError } from "../../../domain/result";
import { isRole, ROLE_LABELS, ROLES, type Role } from "../../../domain/roles";
import type { EmployeeRecord } from "../../../usecases/masters/employees.port";
import { bool, formKey, int, readForm, str, strs, type FormData_ } from "../../form";
import { NOTICES, redirectTo } from "../../http";
import { requirePermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import {
  Alert,
  Badge,
  Checkbox,
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

export const employeeRoutes = new Hono<AppEnv>();

employeeRoutes.use("*", requirePermission("employees.manage"));

function rolesFromForm(form: FormData_): Role[] {
  return strs(form, "roles").filter(isRole);
}

function RoleChecks(props: { selected: readonly Role[]; error?: string | undefined }) {
  return (
    <Field label="役割" name="roles" required error={props.error} hint="複数を兼任できます">
      <div class="inline">
        {ROLES.map((r) => (
          <Checkbox
            name="roles"
            value={r}
            label={ROLE_LABELS[r]}
            checked={props.selected.includes(r)}
          />
        ))}
      </div>
    </Field>
  );
}

function NewEmployeeForm(props: {
  values: { email: string; name: string; roles: readonly Role[] };
  errors: FormErrors;
  error?: DomainError | null;
}) {
  return (
    <form
      method="post"
      action={paths.employeeNew()}
      hx-post={paths.employeeNew()}
      hx-target="this"
      hx-swap="outerHTML"
      class="form card"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      <div class="grid-2">
        <Field
          label="メールアドレス"
          name="email"
          required
          error={props.errors["email"]}
          hint="会社の Google アカウントのアドレス。本人の初回ログインで Google アカウントと結びつきます"
        >
          <Input name="email" type="email" value={props.values.email} />
        </Field>
        <Field label="氏名" name="name" required error={props.errors["name"]}>
          <Input name="name" value={props.values.name} maxlength={100} />
        </Field>
      </div>
      <RoleChecks selected={props.values.roles} error={props.errors["roles"]} />
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          登録する
        </button>
      </div>
    </form>
  );
}

function EditEmployeeForm(props: {
  employee: EmployeeRecord;
  values: { name: string; roles: readonly Role[]; active: boolean };
  version: number;
  errors: FormErrors;
  error?: DomainError | null;
}) {
  const action = paths.employee(props.employee.id);
  return (
    <form
      method="post"
      action={action}
      hx-post={action}
      hx-target="this"
      hx-swap="outerHTML"
      class="form card"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      <Version value={props.version} />
      <div class="grid-2">
        <Field label="メールアドレス" name="email">
          <Input name="email" value={props.employee.email} readonly />
        </Field>
        <Field label="氏名" name="name" required error={props.errors["name"]}>
          <Input name="name" value={props.values.name} maxlength={100} />
        </Field>
      </div>
      <RoleChecks selected={props.values.roles} error={props.errors["roles"]} />
      <Field
        label="利用"
        name="active"
        hint="無効にすると、次の操作から使えなくなります（削除はしません）"
      >
        <Checkbox name="active" label="有効（ログインして使える）" checked={props.values.active} />
      </Field>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          保存する
        </button>
      </div>
    </form>
  );
}

employeeRoutes.get("/", async (c) => {
  const employees = await runQuery(c, "employees.list", {});
  const notice = NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title="社員管理" actor={c.get("actor")} current={paths.employees()}>
      <PageHeader
        title="社員管理"
        actions={
          <a class="btn btn-primary" href={paths.employeeNew()}>
            社員を登録
          </a>
        }
      />
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>氏名</th>
              <th>メールアドレス</th>
              <th>役割</th>
              <th>状態</th>
              <th>Google アカウント</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr class={e.active ? undefined : "muted"}>
                <td>
                  <a href={paths.employee(e.id)}>{e.name}</a>
                </td>
                <td>{e.email}</td>
                <td>
                  {e.roles.map((r) => (
                    <>
                      <Badge kind={r === "admin" ? "warning" : "info"}>{ROLE_LABELS[r]}</Badge>{" "}
                    </>
                  ))}
                </td>
                <td>{e.active ? <Badge kind="success">有効</Badge> : <Badge>無効</Badge>}</td>
                <td>{e.authUserId ? "連携済み" : <span class="muted">未ログイン</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
});

employeeRoutes.get("/new", (c) =>
  c.html(
    <Layout title="社員の登録" actor={c.get("actor")} current={paths.employees()}>
      <PageHeader title="社員の登録" />
      <NewEmployeeForm values={{ email: "", name: "", roles: [] }} errors={{}} />
    </Layout>,
  ),
);

employeeRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const input = { email: str(form, "email"), name: str(form, "name"), roles: rolesFromForm(form) };
  const result = await runCommand(c, "employees.create", input, formKey(form));
  if (result.ok) return redirectTo(c, paths.employees({ notice: "created" }));
  return c.html(
    <NewEmployeeForm values={input} errors={toFormErrors(result.error)} error={result.error} />,
  );
});

employeeRoutes.get("/:id", async (c) => {
  const employee = await runQuery(c, "employees.get", { id: c.req.param("id") });
  if (!employee) return c.notFound();
  const notice = NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title={employee.name} actor={c.get("actor")} current={paths.employees()}>
      <PageHeader title={employee.name}>
        <p class="muted">
          Google アカウント：
          {employee.authUserId ? "連携済み" : "未ログイン（初回ログインで連携します）"}
        </p>
      </PageHeader>
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <EditEmployeeForm
        employee={employee}
        values={employee}
        version={employee.version}
        errors={{}}
      />
    </Layout>,
  );
});

employeeRoutes.post("/:id", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const employee = await runQuery(c, "employees.get", { id });
  if (!employee) return c.notFound();
  const values = {
    name: str(form, "name"),
    roles: rolesFromForm(form),
    active: bool(form, "active"),
  };
  const version = int(form, "version");
  const result = await runCommand(c, "employees.update", { id, version, ...values }, formKey(form));
  if (result.ok) return redirectTo(c, paths.employee(id, { notice: "updated" }));
  return c.html(
    <EditEmployeeForm
      employee={employee}
      values={values}
      version={version}
      errors={toFormErrors(result.error)}
      error={result.error}
    />,
  );
});
