/** ログイン・ログアウト・利用登録なし・開発用ログイン（要件定義書 2章） */
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";

import { isDevAuthAllowed } from "../../infra/do/actor-ref";
import { authFor } from "../auth";
import { readForm, str } from "../form";
import { DEV_ACTOR_COOKIE } from "../middleware";
import { paths } from "../paths";
import type { AppEnv } from "../types";
import { Alert, Field, Input } from "../views/components";
import { BareLayout } from "../views/layout";

export const authRoutes = new Hono<AppEnv>();

function hasUrl(value: unknown): value is { url: string } {
  return (
    typeof value === "object" && value !== null && "url" in value && typeof value.url === "string"
  );
}

authRoutes.get("/login", (c) => {
  const loggedOut = c.req.query("logged_out") === "1";
  return c.html(
    <BareLayout title="ログイン">
      <div class="card login-card" data-clear-drafts={loggedOut ? "true" : undefined}>
        <h1>流通管理システム</h1>
        {loggedOut ? <Alert kind="success">ログアウトしました</Alert> : null}
        <form method="post" action={paths.loginGoogle()}>
          <button type="submit" class="btn btn-primary btn-lg">
            Google でログイン
          </button>
        </form>
        <p class="hint">会社の Google アカウントでログインしてください。</p>
        {isDevAuthAllowed(c.env.ENVIRONMENT) ? (
          <p>
            <a href={paths.devLogin()}>開発用ログイン</a>
          </p>
        ) : null}
      </div>
    </BareLayout>,
  );
});

authRoutes.post("/login/google", async (c) => {
  const res = await authFor(c.env).api.signInSocial({
    body: { provider: "google", callbackURL: paths.home(), errorCallbackURL: paths.noAccess() },
    headers: c.req.raw.headers,
    asResponse: true,
  });
  const data: unknown = await res.clone().json();
  const headers = new Headers({ Location: hasUrl(data) ? data.url : paths.noAccess() });
  for (const cookie of res.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
});

authRoutes.post("/logout", async (c) => {
  const headers = new Headers({ Location: `${paths.login()}?logged_out=1` });
  try {
    const res = await authFor(c.env).api.signOut({ headers: c.req.raw.headers, asResponse: true });
    for (const cookie of res.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  } catch {
    // セッションがない場合もログイン画面へ戻す
  }
  headers.append("Set-Cookie", `${DEV_ACTOR_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  return new Response(null, { status: 303, headers });
});

authRoutes.get("/no-access", (c) =>
  c.html(
    <BareLayout title="利用登録がありません">
      <div class="card login-card">
        <h1>利用登録がありません</h1>
        <p>
          このアカウントは流通管理システムに登録されていないか、無効になっています。管理者に連絡してください。
        </p>
        <p>
          <a href={paths.login()}>ログイン画面に戻る</a>
        </p>
      </div>
    </BareLayout>,
  ),
);

// ---- 開発・テスト用のログイン（本番では 404） ----------------------------------

authRoutes.get("/dev/login", (c) => {
  if (!isDevAuthAllowed(c.env.ENVIRONMENT)) return c.notFound();
  return c.html(
    <BareLayout title="開発用ログイン">
      <div class="card login-card">
        <h1>開発用ログイン</h1>
        <Alert kind="warning">
          開発環境だけで使えます。登録済みの社員のメールアドレスを入力してください。
        </Alert>
        <form method="post" action={paths.devLogin()}>
          <Field label="メールアドレス" name="email">
            <Input name="email" type="email" value={c.env.INITIAL_ADMIN_EMAIL} />
          </Field>
          <button type="submit" class="btn btn-primary">
            ログイン
          </button>
        </form>
      </div>
    </BareLayout>,
  );
});

authRoutes.post("/dev/login", async (c) => {
  if (!isDevAuthAllowed(c.env.ENVIRONMENT)) return c.notFound();
  const form = await readForm(c);
  deleteCookie(c, DEV_ACTOR_COOKIE);
  setCookie(c, DEV_ACTOR_COOKIE, str(form, "email").trim().toLowerCase(), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
  return c.redirect(paths.home(), 303);
});
