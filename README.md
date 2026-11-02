# 流通管理システム

菓子・食品の仕入・在庫・販売を扱う社内向けの業務システムです。発注・入荷・支払、受注・発送・請求・入金、在庫、販売先廃棄を1つの画面で扱います。

- 要件：[docs/requirements.md](docs/requirements.md)（正本は [要件定義書](https://claude.ai/artifact/474X7tYjok4fdwbi4TgcLV)）
- 開発のルール：[AGENTS.md](AGENTS.md)

## 構成

| 区分       | 採用                                                   |
| ---------- | ------------------------------------------------------ |
| 画面と API | Hono + htmx（JSX でサーバー側描画）                    |
| 実行環境   | Cloudflare Workers                                     |
| 業務 DB    | Durable Objects の SQLite（Drizzle）                   |
| ログイン   | Better Auth + Google（Workspace のドメインに限定）、D1 |
| ファイル   | R2（帳票 PDF、CSV、バックアップ）                      |
| 非同期処理 | Queues、Cron Triggers                                  |
| 帳票       | Browser Rendering で PDF 化                            |
| メール     | Cloudflare Email Service                               |

## 手元での開発

必要なもの：Node.js 22 と Bun（`mise install` で入ります）

```sh
bun install
cp .dev.vars.example .dev.vars   # 値を入れる（開発用ログインだけなら空でもよい）
bun run dev                      # http://localhost:8787
```

`/dev/login` から、登録済みの社員のメールアドレスでログインできます（開発環境とテストだけで有効）。最初の管理者は `wrangler.jsonc` の `INITIAL_ADMIN_EMAIL` です。テストデータは `bun run db:seed` で入れます。

## 検査

```sh
bun run check      # 整形・lint・型・テスト・未使用コードの検出
bun run test:e2e   # E2E テスト（Playwright）
```

## 配備

`main` への push で検証環境に自動で配備し、本番は承認の後に配備します（`.github/workflows/deploy.yml`）。手元から本番に配備しないでください。

初回の準備：

1. Cloudflare で D1（`AUTH_DB`）、R2（`FILES`、7年のバケットロック）、Queues（`JOBS`）を作り、`wrangler.jsonc` の ID を書き換える
2. 秘密情報を登録する：`wrangler secret put BETTER_AUTH_SECRET` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`（`--env staging` と `--env production` のそれぞれ）
3. Google Cloud で OAuth クライアント（社内向けの同意画面）を作り、リダイレクト URI に `https://<ドメイン>/api/auth/callback/google` を登録する
4. GitHub の Environments に `staging` と `production`（必須レビューつき）を作り、`CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を登録する
