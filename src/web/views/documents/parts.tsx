/**
 * 帳票のテンプレートで共通に使う部品（見出し、宛名、発行者、番号と日付）。
 * 値を表示するだけで、金額の計算はしない（計算はユースケースで行い、スナップショットに入れる）。
 */
import type { Child } from "hono/jsx";

import { jaDate, postal } from "../format";

export function DocumentTitle(props: { title: string }) {
  return <h1 class="doc-title">{props.title}</h1>;
}

/** 番号・日付などを右上に並べる */
export function DocumentMeta(props: { items: readonly (readonly [string, Child])[] }) {
  return (
    <table class="doc-meta">
      <tbody>
        {props.items.map(([label, value]) => (
          <tr>
            <th>{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface PartyBlock {
  readonly name: string;
  readonly postalCode?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly fax?: string | null | undefined;
  readonly email?: string | null | undefined;
}

/** 宛名（左上）。敬称は取引先の設定（御中・様） */
export function Addressee(props: { to: PartyBlock & { readonly honorific: string } }) {
  const t = props.to;
  return (
    <div class="doc-to">
      {t.postalCode || t.address ? (
        <p class="small">
          {postal(t.postalCode)} {t.address ?? ""}
        </p>
      ) : null}
      <p class="name">
        {t.name} {t.honorific}
      </p>
    </div>
  );
}

/** 発行者（右上）。インボイスの登録番号があれば載せる */
export function Issuer(props: {
  from: PartyBlock & { readonly registrationNumber?: string | null | undefined };
}) {
  const f = props.from;
  return (
    <div class="doc-from">
      <p class="name">{f.name}</p>
      {f.registrationNumber ? <p>登録番号：{f.registrationNumber}</p> : null}
      {f.postalCode || f.address ? (
        <p>
          {postal(f.postalCode)} {f.address ?? ""}
        </p>
      ) : null}
      {f.phone ? <p>TEL：{f.phone}</p> : null}
      {f.fax ? <p>FAX：{f.fax}</p> : null}
      {f.email ? <p>{f.email}</p> : null}
    </div>
  );
}

/** 業務日（YYYY-MM-DD）を帳票向けに「2026年11月2日」で表示する */
export function DocumentDate(props: { date: string }) {
  return <>{jaDate(props.date)}</>;
}
