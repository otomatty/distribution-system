/** 画面の共通レイアウト：ヘッダー、業務の区分ごとのメニュー、通信断の表示 */
import type { Child } from "hono/jsx";

import { can, isRole, type Permission } from "../../domain/roles";
import type { ActorSummary } from "../../infra/do/business-db";
import { paths } from "../paths";

interface NavItem {
  readonly label: string;
  readonly href: string;
  /** 指定した権限を持つ人にだけ表示する（閲覧は全員ができるので、管理者専用の画面にだけ付ける） */
  readonly permission?: Permission;
}

const NAV: readonly { readonly title: string; readonly items: readonly NavItem[] }[] = [
  { title: "", items: [{ label: "ダッシュボード", href: paths.home() }] },
  {
    title: "仕入",
    items: [
      { label: "発注", href: paths.purchaseOrders() },
      { label: "入荷予定", href: paths.receiving() },
      { label: "仕入先請求書", href: paths.supplierInvoices() },
      { label: "支払予定", href: paths.payables() },
    ],
  },
  {
    title: "販売",
    items: [
      { label: "受注", href: paths.salesOrders() },
      { label: "発送リスト", href: paths.shipping() },
      { label: "請求書", href: paths.invoices() },
      { label: "入金", href: paths.customerReceipts() },
      { label: "売掛残高", href: paths.receivables() },
      { label: "販売先廃棄", href: paths.disposals() },
    ],
  },
  {
    title: "在庫",
    items: [
      { label: "在庫一覧", href: paths.stock() },
      { label: "在庫操作", href: paths.stockOperationNew() },
      { label: "在庫操作の履歴", href: paths.stockOperations() },
      { label: "棚卸", href: paths.stocktaking() },
    ],
  },
  {
    title: "マスタ",
    items: [
      { label: "商品", href: paths.items() },
      { label: "取引先", href: paths.partners() },
      { label: "保管場所", href: paths.locations() },
      { label: "払い出し先店舗", href: paths.stores() },
      { label: "ジャンル", href: paths.genres() },
    ],
  },
  {
    title: "集計・帳票",
    items: [
      { label: "帳票の検索", href: paths.documents() },
      { label: "売上・仕入の集計", href: paths.reports() },
      { label: "処理状況", href: paths.jobs() },
    ],
  },
  {
    title: "管理",
    items: [
      { label: "社員管理", href: paths.employees(), permission: "employees.manage" },
      { label: "設定", href: paths.settings(), permission: "settings.manage" },
    ],
  },
];

function roleList(actor: ActorSummary) {
  return actor.roles.filter(isRole);
}

export function Layout(props: {
  title: string;
  actor: ActorSummary;
  current?: string;
  children: Child;
  touch?: boolean;
}) {
  const roles = roleList(props.actor);
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <title>{props.title} | 流通管理システム</title>
        {/* htmx が埋め込みの <style> を足すと CSP（style-src 'self'）に違反するので止める。代わりの CSS は app.css */}
        <meta name="htmx-config" content='{"includeIndicatorStyles":false}' />
        <link rel="stylesheet" href="/assets/app.css" />
        <script src="/assets/vendor/htmx.min.js" defer></script>
        <script src="/assets/app.js" defer></script>
      </head>
      <body class={props.touch ? "touch" : undefined}>
        <div id="offline-banner" class="offline-banner" hidden role="alert">
          通信が途切れています。入力した内容は残っています。通信が戻ったら「再送信」を押してください。
          <button type="button" class="btn btn-sm" id="offline-retry" hidden>
            再送信
          </button>
        </div>
        <header class="app-header">
          <a class="brand" href={paths.home()}>
            流通管理システム
          </a>
          <div class="user">
            <span>{props.actor.name}</span>
            <form method="post" action={paths.logout()}>
              <button type="submit" class="btn btn-secondary btn-sm">
                ログアウト
              </button>
            </form>
          </div>
        </header>
        <div class="app-body">
          <nav class="app-nav" aria-label="メニュー">
            {NAV.map((group) => {
              const items = group.items.filter((i) => !i.permission || can(roles, i.permission));
              if (items.length === 0) return null;
              return (
                <div class="nav-group">
                  {group.title ? <p class="nav-title">{group.title}</p> : null}
                  <ul>
                    {items.map((i) => (
                      <li>
                        <a
                          href={i.href}
                          aria-current={props.current === i.href ? "page" : undefined}
                        >
                          {i.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
          <main class="app-main" id="main">
            {props.children}
          </main>
        </div>
      </body>
    </html>
  );
}

/** ログイン前の画面（ログイン、利用登録なし） */
export function BareLayout(props: { title: string; children: Child }) {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <title>{props.title} | 流通管理システム</title>
        <link rel="stylesheet" href="/assets/app.css" />
        <script src="/assets/app.js" defer></script>
      </head>
      <body class="bare">
        <main class="bare-main">{props.children}</main>
      </body>
    </html>
  );
}
