/**
 * 結合テストの補助。開発用ログイン（dev_actor の Cookie）で画面のルートを呼ぶ。
 * 業務 DB のデータは、システムの操作者（system）でユースケースを呼んで作る。
 */
import { env, exports } from "cloudflare:workers";

import type { Result } from "../../src/domain/result";
import type { Role } from "../../src/domain/roles";
import { businessDb } from "../../src/infra/do/client";
import type {
  CommandInput,
  CommandName,
  CommandOutput,
  QueryInput,
  QueryName,
  QueryOutput,
} from "../../src/usecases/registry";

export const ORIGIN = "http://localhost:8787";
export const ADMIN_EMAIL = "admin@example.co.jp";

let counter = 0;

/** 社員を登録して、その社員のメールアドレスを返す */
export async function createEmployee(roles: Role[], name = "テスト社員"): Promise<string> {
  counter += 1;
  const email = `user${counter}-${roles.join("-") || "none"}@example.co.jp`;
  await systemCommand("employees.create", { email, name, roles });
  return email;
}

export async function systemCommand<N extends CommandName>(
  name: N,
  input: CommandInput<N>,
  key: string | null = null,
): Promise<CommandOutput<N>> {
  const r = (await businessDb(env).command(
    name,
    input,
    { kind: "system" },
    key,
  )) as Result<unknown>;
  if (!r.ok)
    throw new Error(`${name} failed: ${r.error.message} ${JSON.stringify(r.error.fields ?? [])}`);
  return r.value as CommandOutput<N>;
}

export async function systemQuery<N extends QueryName>(
  name: N,
  input: QueryInput<N>,
): Promise<QueryOutput<N>> {
  const r = (await businessDb(env).query(name, input, { kind: "system" })) as Result<unknown>;
  if (!r.ok) throw new Error(`${name} failed: ${r.error.message}`);
  return r.value as QueryOutput<N>;
}

/** 社員として操作するクライアント */
export function as(email: string) {
  const cookie = `dev_actor=${encodeURIComponent(email)}`;
  return {
    get(path: string, headers: Record<string, string> = {}) {
      return exports.default.fetch(
        new Request(ORIGIN + path, { headers: { Cookie: cookie, ...headers }, redirect: "manual" }),
      );
    },
    post(
      path: string,
      form: Record<string, string | string[]>,
      headers: Record<string, string> = {},
    ) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (Array.isArray(v)) for (const x of v) body.append(k, x);
        else body.append(k, v);
      }
      return exports.default.fetch(
        new Request(ORIGIN + path, {
          method: "POST",
          body,
          headers: {
            Cookie: cookie,
            Origin: ORIGIN,
            "Content-Type": "application/x-www-form-urlencoded",
            ...headers,
          },
          redirect: "manual",
        }),
      );
    },
    /** htmx からの要求として送る */
    hx(path: string, form: Record<string, string | string[]>) {
      return this.post(path, form, { "HX-Request": "true" });
    },
  };
}

export function anonymous() {
  return {
    get(path: string) {
      return exports.default.fetch(new Request(ORIGIN + path, { redirect: "manual" }));
    },
  };
}

export function newKey(): string {
  return crypto.randomUUID();
}
