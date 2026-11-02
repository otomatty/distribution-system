/**
 * 仕入先請求書の PDF の欄（要件定義書 3.7 Should、7章 電子帳簿保存法）。添付した版の一覧とダウンロード、
 * 新しい版の追加。保存した PDF は消せない（差し替えは新しい版として追加し、前の版も残る）。
 */
import type { DomainError } from "../../domain/result";
import type { SupplierInvoiceView } from "../../usecases/purchasing/supplier-invoices";
import { paths } from "../paths";
import { Alert, Badge, ErrorSummary, Field, FormKey } from "./components";
import { dateTime } from "./format";

/** ファイルの大きさの表示（1,024 バイトを 1 KB とする） */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentSection(props: {
  view: SupplierInvoiceView;
  error?: DomainError | null | undefined;
  notice?: string | undefined;
}) {
  const { invoice, attachments, actions } = props.view;
  const latest = attachments[0];
  return (
    <section class="card" id="si-attachments">
      <h2>請求書の PDF</h2>
      <p class="hint">
        仕入先から受け取った請求書の PDF を保存します（電子帳簿保存法）。保存した PDF
        は消せません。差し替えるときは新しい版として追加します（前の版も残り、ダウンロードできます）。
      </p>
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      <ErrorSummary error={props.error} />
      {latest ? (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>版</th>
                <th>ファイル名</th>
                <th class="num">大きさ</th>
                <th>保存</th>
                <th>SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {attachments.map((a) => (
                <tr class={a.id === latest.id ? undefined : "row-muted"}>
                  <td class="nowrap">
                    {a.versionNo}版 {a.id === latest.id ? <Badge kind="success">最新</Badge> : null}
                  </td>
                  <td>
                    <a href={paths.supplierInvoiceAttachment(invoice.id, a.id)}>{a.fileName}</a>
                  </td>
                  <td class="num nowrap">{fileSize(a.size)}</td>
                  <td class="small">
                    {dateTime(a.createdAt)}
                    <div class="muted">{a.createdByName ?? ""}</div>
                  </td>
                  <td class="small">
                    <code class="hash" title={a.sha256}>
                      {a.sha256.slice(0, 12)}…
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">まだ PDF を添付していません。</p>
      )}
      {actions.attach ? (
        <form
          method="post"
          action={paths.supplierInvoiceAttachments(invoice.id)}
          enctype="multipart/form-data"
          hx-post={paths.supplierInvoiceAttachments(invoice.id)}
          hx-encoding="multipart/form-data"
          hx-target="#si-attachments"
          hx-swap="outerHTML"
          class="form"
        >
          <FormKey />
          <Field
            label={latest ? "新しい版の PDF" : "請求書の PDF"}
            name="file"
            hint="PDF だけ、10 MB まで"
          >
            <input id="f-file" type="file" name="file" accept="application/pdf,.pdf" required />
          </Field>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">
              {latest ? "新しい版として追加する" : "PDF を添付する"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
