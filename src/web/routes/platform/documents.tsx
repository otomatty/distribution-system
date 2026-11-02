/**
 * 帳票の検索（電子帳簿保存法：取引年月日・金額・取引先などで検索）、帳票の詳細、PDF のダウンロード、
 * 送付（メール・手動の記録・再送）、一括 PDF、CSV 出力（要件定義書 3.14、5章 帳票の検索、7章）。
 */
import { Hono, type Context } from "hono";

import {
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  documentFileName,
  RENDER_STATUS_LABELS,
  SEND_METHOD_LABELS,
  SEND_STATUS_LABELS,
  type RenderStatus,
  type SendStatus,
} from "../../../domain/documents";
import type { DomainError } from "../../../domain/result";
import { fileResponse } from "../../../infra/storage/files";
import type { DocumentSummary } from "../../../usecases/platform/documents.port";
import type { QueryOutput } from "../../../usecases/registry";
import { exportCsv } from "../../csv-exports";
import { choice, formKey, readForm, str, strs } from "../../form";
import { isHtmx, redirectTo } from "../../http";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { queryAs, runCommand, runQuery } from "../../usecase";
import {
  Alert,
  Badge,
  DescriptionList,
  EmptyState,
  ErrorSummary,
  Field,
  FormKey,
  Input,
  PageHeader,
  Pagination,
  Select,
  toFormErrors,
  type FormErrors,
} from "../../views/components";
import { CsvButton } from "../../views/csv-button";
import { PRINT_CSP } from "../../views/documents/layout";
import { dateTime, yen } from "../../views/format";
import { Layout } from "../../views/layout";

export const documentRoutes = new Hono<AppEnv>();

type DocumentDetail = NonNullable<QueryOutput<"documents.get">>;

const NOTICES: Readonly<Record<string, string>> = {
  rerender: "PDF の作り直しを受け付けました",
};

const TYPE_OPTIONS = DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] }));
const CANCELLED_OPTIONS = [
  { value: "exclude", label: "取消済みを除く" },
  { value: "only", label: "取消済みだけ" },
];
const RENDER_OPTIONS = [
  { value: "pending", label: RENDER_STATUS_LABELS.pending },
  { value: "failed", label: RENDER_STATUS_LABELS.failed },
];
const SEND_OPTIONS = [
  { value: "failed", label: "送付に失敗" },
  { value: "sent", label: "送付済み" },
  { value: "unsent", label: "未送付" },
];

// ---- 絞り込み条件 -----------------------------------------------------------------

/** 金額の欄。未入力は undefined、数字でなければ NaN（ユースケースの検証でエラーになる） */
function amountParam(text: string): number | undefined {
  const t = text.replaceAll(",", "").trim();
  if (t === "") return undefined;
  return /^-?\d+$/.test(t) ? Number(t) : Number.NaN;
}

/** URL のクエリ・CSV のフォームから、帳票の検索条件を作る（名前は画面と CSV で共通） */
function filterFrom(get: (name: string) => string) {
  const text = (name: string) => get(name).trim() || undefined;
  const pick = <T extends string>(name: string, allowed: readonly T[]) =>
    allowed.find((a) => a === get(name));
  return {
    documentType: pick("documentType", DOCUMENT_TYPES),
    dateFrom: text("dateFrom"),
    dateTo: text("dateTo"),
    amountMin: amountParam(get("amountMin")),
    amountMax: amountParam(get("amountMax")),
    partnerId: text("partnerId"),
    number: text("number"),
    cancelled: pick("cancelled", ["exclude", "only"] as const),
    renderStatus: pick("renderStatus", ["pending", "ready", "failed"] as const),
    sendStatus: pick("sendStatus", ["failed", "sent", "unsent"] as const),
  };
}

type Filter = ReturnType<typeof filterFrom>;

function filterQuery(f: Filter): Query {
  return { ...f };
}

function inputValue(v: string | number | undefined): string {
  return v === undefined ? "" : String(v);
}

async function partnerOptions(c: Context<AppEnv>) {
  const [suppliers, customers] = await Promise.all([
    runQuery(c, "partners.options", { role: "supplier" }),
    runQuery(c, "partners.options", { role: "customer" }),
  ]);
  const byId = new Map([...suppliers, ...customers].map((p) => [p.id, p]));
  return [...byId.values()]
    .toSorted((a, b) => a.kana.localeCompare(b.kana, "ja"))
    .map((p) => ({ value: p.id, label: p.name }));
}

// ---- 表示の部品 -------------------------------------------------------------------

function RenderBadge(props: { status: RenderStatus }) {
  if (props.status === "ready") return null;
  return (
    <Badge kind={props.status === "failed" ? "danger" : "info"}>
      {RENDER_STATUS_LABELS[props.status]}
    </Badge>
  );
}

function SendBadge(props: { status: SendStatus | null }) {
  if (props.status === null) return <Badge>未送付</Badge>;
  const kind = props.status === "sent" ? "success" : props.status === "failed" ? "danger" : "info";
  return <Badge kind={kind}>{SEND_STATUS_LABELS[props.status]}</Badge>;
}

function ResultsTable(props: { rows: readonly DocumentSummary[] }) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>
              <span class="muted small">選択</span>
            </th>
            <th>種類</th>
            <th>番号</th>
            <th>取引年月日</th>
            <th>取引先</th>
            <th class="num">金額（税込）</th>
            <th>状態</th>
            <th>送付</th>
            <th>PDF</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((d) => (
            <tr class={d.cancelled ? "row-warning" : undefined}>
              <td>
                <input
                  type="checkbox"
                  name="documentIds"
                  value={d.id}
                  aria-label={`${d.number}を選ぶ`}
                />
              </td>
              <td>{DOCUMENT_TYPE_LABELS[d.documentType]}</td>
              <td>
                <a href={paths.document(d.id)}>{d.number}</a>
              </td>
              <td class="nowrap">{d.transactionDate}</td>
              <td>{d.partnerName ?? ""}</td>
              <td class="num">{yen(d.amount)}</td>
              <td>
                {d.cancelled ? <Badge kind="warning">取消済み</Badge> : null}{" "}
                <RenderBadge status={d.status} />
              </td>
              <td>
                <SendBadge status={d.lastSendStatus} />
              </td>
              <td>
                {d.status === "ready" ? (
                  <a href={paths.documentDownload(d.id)} class="btn btn-secondary btn-sm">
                    ダウンロード
                  </a>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- 検索 ---------------------------------------------------------------------

documentRoutes.get("/", async (c) => {
  const filter = filterFrom((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const result = await queryAs(c.env, c.get("actorRef"), "documents.search", {
    ...filter,
    page,
    pageSize: 50,
  });
  if (!result.ok && result.error.code !== "validation") {
    return c.text(result.error.message, result.error.code === "forbidden" ? 403 : 400);
  }
  const errors = result.ok ? {} : toFormErrors(result.error);
  const partners = await partnerOptions(c);
  const query = filterQuery(filter);
  const notice = c.req.query("notice") === "bulk_empty" ? "PDF にする帳票を選んでください" : null;
  return c.html(
    <Layout title="帳票の検索" actor={c.get("actor")} current={paths.documents()}>
      <PageHeader title="帳票の検索">
        <p class="muted">
          発行した発注書・納品書・請求書・返還請求書を、取引年月日・金額・取引先などで探せます。
        </p>
      </PageHeader>
      {notice ? <Alert kind="warning">{notice}</Alert> : null}
      <form
        class="filters"
        method="get"
        action={paths.documents()}
        hx-get={paths.documents()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change, input changed delay:400ms from:input[name=number]"
      >
        <Field label="種類" name="documentType">
          <Select
            name="documentType"
            value={filter.documentType ?? ""}
            options={TYPE_OPTIONS}
            empty="すべて"
          />
        </Field>
        <Field label="取引年月日（から）" name="dateFrom" error={errors["dateFrom"]}>
          <Input name="dateFrom" type="date" value={filter.dateFrom} />
        </Field>
        <Field label="取引年月日（まで）" name="dateTo" error={errors["dateTo"]}>
          <Input name="dateTo" type="date" value={filter.dateTo} />
        </Field>
        <Field label="金額（以上）" name="amountMin" error={errors["amountMin"]}>
          <Input name="amountMin" inputmode="numeric" value={inputValue(filter.amountMin)} />
        </Field>
        <Field label="金額（以下）" name="amountMax" error={errors["amountMax"]}>
          <Input name="amountMax" inputmode="numeric" value={inputValue(filter.amountMax)} />
        </Field>
        <Field label="取引先" name="partnerId">
          <Select
            name="partnerId"
            value={filter.partnerId ?? ""}
            options={partners}
            empty="すべて"
          />
        </Field>
        <Field label="番号" name="number">
          <Input name="number" type="search" value={filter.number} maxlength={50} />
        </Field>
        <Field label="取消" name="cancelled">
          <Select
            name="cancelled"
            value={filter.cancelled ?? ""}
            options={CANCELLED_OPTIONS}
            empty="すべて"
          />
        </Field>
        <Field label="送付" name="sendStatus">
          <Select
            name="sendStatus"
            value={filter.sendStatus ?? ""}
            options={SEND_OPTIONS}
            empty="すべて"
          />
        </Field>
        <Field label="PDF" name="renderStatus">
          <Select
            name="renderStatus"
            value={filter.renderStatus ?? ""}
            options={RENDER_OPTIONS}
            empty="すべて"
          />
        </Field>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        {result.ok ? null : <ErrorSummary error={result.error} />}
        <div class="toolbar">
          <CsvButton action={paths.documentsCsv()} filters={query} />
        </div>
        {!result.ok || result.value.rows.length === 0 ? (
          <EmptyState message="条件に合う帳票はありません" />
        ) : (
          <form method="post" action={paths.documentsBulk()}>
            <FormKey />
            <ResultsTable rows={result.value.rows} />
            <div class="toolbar">
              <button type="submit" class="btn btn-secondary">
                選んだ帳票を1つの PDF にまとめる
              </button>
              <span class="hint">作成の進み具合は「処理状況」で確認できます</span>
            </div>
          </form>
        )}
        {result.ok ? (
          <Pagination
            page={result.value.page}
            pageSize={result.value.pageSize}
            total={result.value.total}
            href={(p) => paths.documents({ ...query, page: p })}
          />
        ) : null}
      </section>
    </Layout>,
  );
});

documentRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "documents",
    filterFrom((name) => str(form, name)),
    formKey(form),
  );
});

documentRoutes.post("/bulk", async (c) => {
  const form = await readForm(c);
  const documentIds = strs(form, "documentIds");
  if (documentIds.length === 0) return redirectTo(c, paths.documents({ notice: "bulk_empty" }));
  const result = await runCommand(c, "jobs.bulkDocuments", { documentIds }, formKey(form));
  if (!result.ok) return c.text(result.error.message, 400);
  return redirectTo(c, paths.jobs({ notice: "bulk" }));
});

// ---- 詳細 ---------------------------------------------------------------------

async function loadDetail(c: Context<AppEnv>, id: string): Promise<DocumentDetail | null> {
  return runQuery(c, "documents.get", { id });
}

/** 送付の欄（送付の操作と送付履歴）。送信中の送付があれば、終わるまで3秒ごとに描き直す */
function SendPanel(props: {
  detail: DocumentDetail;
  errors?: FormErrors;
  error?: DomainError | null;
  notice?: string | null;
  values?: { method: string; recipient: string; note: string };
}) {
  const { document: doc, partner, sends } = props.detail;
  const pending = sends.some((s) => s.status === "pending");
  const errors = props.errors ?? {};
  const values = props.values ?? {
    method: partner?.defaultSendMethod === "email" ? "email" : "manual",
    recipient: partner?.email ?? "",
    note: "",
  };
  const url = paths.documentSends(doc.id);
  return (
    <section
      class="card"
      id="send-panel"
      {...(pending ? { "hx-get": url, "hx-trigger": "every 3s", "hx-swap": "outerHTML" } : {})}
    >
      <h2>送付</h2>
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      {props.detail.sendBlocker ? <Alert kind="warning">{props.detail.sendBlocker}</Alert> : null}
      {props.detail.canSend && !props.detail.sendBlocker ? (
        <form
          method="post"
          action={url}
          hx-post={url}
          hx-target="#send-panel"
          hx-swap="outerHTML"
          class="form"
        >
          <ErrorSummary error={props.error} />
          <FormKey />
          <fieldset>
            <legend>送付の方法</legend>
            <label class="checkbox">
              <input type="radio" name="method" value="email" checked={values.method === "email"} />{" "}
              メールで送る（PDF を添付）
            </label>
            <label class="checkbox">
              <input
                type="radio"
                name="method"
                value="manual"
                checked={values.method === "manual"}
              />{" "}
              手動で送付したことを記録する（FAX など）
            </label>
            <p class="hint">
              取引先の既定の送付方法：
              {partner?.defaultSendMethod === "email" ? "メール" : "送付しない（手動）"}
              {partner?.fax ? `　FAX：${partner.fax}` : ""}
            </p>
          </fieldset>
          <div class="grid-2">
            <Field
              label="宛先のメールアドレス（メールの場合）"
              name="recipient"
              error={errors["recipient"]}
            >
              <Input name="recipient" type="email" value={values.recipient} />
            </Field>
            <Field
              label="メモ（手動の場合。送った FAX 番号など）"
              name="note"
              error={errors["note"]}
            >
              <Input name="note" value={values.note} maxlength={500} />
            </Field>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">
              送付する
            </button>
          </div>
        </form>
      ) : null}
      <h3>送付履歴</h3>
      {sends.length === 0 ? (
        <p class="muted">まだ送付していません</p>
      ) : (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>日時</th>
                <th>方法</th>
                <th>宛先・メモ</th>
                <th>結果</th>
                <th>操作した人</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sends.map((s) => (
                <tr class={s.status === "failed" ? "row-danger" : undefined}>
                  <td class="nowrap">{dateTime(s.sentAt ?? s.createdAt)}</td>
                  <td>{SEND_METHOD_LABELS[s.method]}</td>
                  <td>{s.method === "email" ? (s.recipient ?? "") : (s.note ?? "")}</td>
                  <td>
                    <SendBadge status={s.status} />
                    {s.error ? <div class="small">{s.error}</div> : null}
                  </td>
                  <td>{s.createdByName ?? ""}</td>
                  <td>
                    {props.detail.retryableSendId === s.id ? (
                      <form
                        method="post"
                        action={paths.documentSendRetry(doc.id, s.id)}
                        hx-post={paths.documentSendRetry(doc.id, s.id)}
                        hx-target="#send-panel"
                        hx-swap="outerHTML"
                      >
                        <FormKey />
                        <button type="submit" class="btn btn-secondary btn-sm">
                          再送する
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

documentRoutes.get("/:id", async (c) => {
  const detail = await loadDetail(c, c.req.param("id"));
  if (!detail) return c.notFound();
  const doc = detail.document;
  const label = DOCUMENT_TYPE_LABELS[doc.documentType];
  const notice = NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title={`${label} ${doc.number}`} actor={c.get("actor")} current={paths.documents()}>
      <PageHeader
        title={`${label} ${doc.number}`}
        actions={
          doc.status === "ready" ? (
            <a class="btn btn-primary" href={paths.documentDownload(doc.id)}>
              PDF をダウンロード
            </a>
          ) : null
        }
      >
        <p>
          {doc.cancelled ? <Badge kind="warning">取消済み</Badge> : null}{" "}
          <RenderBadge status={doc.status} />
        </p>
      </PageHeader>
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {doc.status === "failed" ? (
        <Alert kind="error">
          <strong>PDF を作成できませんでした。</strong>
          {detail.renderError ? <div>{detail.renderError}</div> : null}
          {detail.canRerender ? (
            <form method="post" action={paths.documentRerender(doc.id)}>
              <FormKey />
              <button type="submit" class="btn btn-secondary btn-sm">
                PDF を作り直す
              </button>
            </form>
          ) : (
            <div>管理者に PDF の作り直しを依頼してください。</div>
          )}
        </Alert>
      ) : null}
      {doc.status === "pending" ? (
        <Alert kind="info">
          PDF を作成しています。しばらくしてから画面を開き直してください。
          {detail.canRerender ? (
            <form method="post" action={paths.documentRerender(doc.id)}>
              <FormKey />
              <button type="submit" class="btn btn-secondary btn-sm">
                PDF の作成をやり直す
              </button>
            </form>
          ) : null}
        </Alert>
      ) : null}
      <section class="card">
        <h2>帳票の情報</h2>
        <DescriptionList
          items={[
            ["種類", label],
            ["番号", doc.number],
            ["取引年月日", doc.transactionDate],
            [
              "取引先",
              detail.partner ? (
                <a href={paths.partner(detail.partner.id)}>{detail.partner.name}</a>
              ) : (
                doc.partnerName
              ),
            ],
            ["金額（税込）", yen(doc.amount)],
            ["PDF", RENDER_STATUS_LABELS[doc.status]],
            ["発行日時", dateTime(doc.createdAt)],
            ["発行した人", doc.createdByName],
            ["取消", doc.cancelled ? `取消済み（${dateTime(doc.updatedAt)}）` : null],
          ]}
        />
      </section>
      <SendPanel detail={detail} />
    </Layout>,
  );
});

documentRoutes.get("/:id/sends", async (c) => {
  const detail = await loadDetail(c, c.req.param("id"));
  if (!detail) return c.notFound();
  return c.html(<SendPanel detail={detail} />);
});

documentRoutes.post("/:id/sends", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const method = choice(form, "method", ["email", "manual"] as const, "email" as const);
  const values = { method, recipient: str(form, "recipient"), note: str(form, "note") };
  const result =
    method === "email"
      ? await runCommand(
          c,
          "documents.send",
          { documentId: id, recipient: values.recipient },
          formKey(form),
        )
      : await runCommand(
          c,
          "documents.recordManualSend",
          { documentId: id, note: values.note },
          formKey(form),
        );
  const detail = await loadDetail(c, id);
  if (!detail) return c.notFound();
  if (!isHtmx(c)) return redirectTo(c, paths.document(id));
  if (result.ok) {
    return c.html(
      <SendPanel
        detail={detail}
        notice={
          method === "email"
            ? "送付を受け付けました。送信の結果は下の送付履歴に表示されます"
            : "手動で送付したことを記録しました"
        }
      />,
    );
  }
  return c.html(
    <SendPanel
      detail={detail}
      values={values}
      errors={toFormErrors(result.error)}
      error={result.error}
    />,
  );
});

documentRoutes.post("/:id/sends/:sendId/retry", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "documents.retrySend",
    { sendId: c.req.param("sendId") },
    formKey(form),
  );
  const detail = await loadDetail(c, id);
  if (!detail) return c.notFound();
  if (!isHtmx(c)) return redirectTo(c, paths.document(id));
  return c.html(
    <SendPanel
      detail={detail}
      notice={result.ok ? "再送を受け付けました" : null}
      error={result.ok ? null : result.error}
    />,
  );
});

documentRoutes.post("/:id/rerender", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(c, "documents.rerender", { documentId: id }, formKey(form));
  if (!result.ok)
    return c.text(result.error.message, result.error.code === "forbidden" ? 403 : 409);
  return redirectTo(c, `${paths.document(id)}?notice=rerender`);
});

// ---- ダウンロード -----------------------------------------------------------------

documentRoutes.get("/:id/download", async (c) => {
  const detail = await loadDetail(c, c.req.param("id"));
  if (!detail) return c.notFound();
  const doc = detail.document;
  if (doc.status !== "ready" || !doc.r2Key) {
    return c.text("PDF を作成中です。しばらくしてからもう一度お試しください", 409);
  }
  const extension = doc.r2Key.endsWith(".pdf") ? "pdf" : "html";
  const response = await fileResponse(
    c.env.FILES,
    doc.r2Key,
    documentFileName(doc.documentType, doc.number, extension),
    // 開発環境の HTML の帳票は埋め込みの <style> を使うので、その応答だけ CSP を変える
    extension === "html" ? { "Content-Security-Policy": PRINT_CSP } : {},
  );
  return response ?? c.text("ファイルが見つかりません。管理者に連絡してください", 404);
});
