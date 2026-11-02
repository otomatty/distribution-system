/**
 * 業務 DB を特定の時点に戻す（要件定義書 7章 可用性とバックアップ：Durable Objects の特定時点への復元（30日））。
 * 管理者だけが使う。手順・本番の追加の鍵・検証環境での試し方は docs/operations.md 3章。
 *
 * 1. 戻す日時を選ぶと、戻すと失われる操作（操作履歴）を出す（照会 restore.preview）
 * 2. 確認のために戻す日時を入力し、理由を書いて送ると、業務 DB が復元を予約し（restoreToPointInTime）、
 *    Durable Object を作り直してから（restartForRestore）、戻ったことを記録する（completeRestore）
 */
import { Hono, type Context } from "hono";

import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS, auditLabel } from "../../../domain/audit";
import { isProductionLike, restoreLockError } from "../../../domain/restore";
import type { DomainError } from "../../../domain/result";
import { businessDb } from "../../../infra/do/client";
import type { RestoreRecord } from "../../../infra/do/restore";
import { log } from "../../../infra/observability/log";
import type { RestorePreview } from "../../../usecases/platform/restore";
import { formKey, readForm, str } from "../../form";
import { requirePermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runQuery } from "../../usecase";
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
  TextArea,
  toFormErrors,
  type FormErrors,
} from "../../views/components";
import { dateTime } from "../../views/format";
import { Layout } from "../../views/layout";

export const restoreRoutes = new Hono<AppEnv>();

restoreRoutes.use("*", requirePermission("platform.admin"));

/** 戻す日時の入力欄（datetime-local）は「YYYY-MM-DDTHH:mm(:ss)」、確認の文字列は「YYYY-MM-DD HH:mm:ss」 */
function inputValue(confirmationText: string): string {
  return confirmationText.replace(" ", "T");
}

function StatusBadge(props: { status: RestoreRecord["status"] }) {
  return props.status === "restored" ? (
    <Badge kind="success">戻した</Badge>
  ) : (
    <Badge kind="warning">予約のまま</Badge>
  );
}

function EnvironmentNotice(props: { c: Context<AppEnv> }) {
  const env = props.c.env;
  if (!isProductionLike(env.ENVIRONMENT)) {
    return (
      <Alert kind="info">
        この環境（{env.ENVIRONMENT}
        ）では、管理者の確認だけで戻せます。本番では、運用担当が RESTORE_UNLOCK_UNTIL
        を設定している間だけ戻せます。
      </Alert>
    );
  }
  const locked = restoreLockError(env.ENVIRONMENT, env.RESTORE_UNLOCK_UNTIL, new Date());
  return locked ? (
    <Alert kind="warning">
      <strong>本番環境の復元は止めています。</strong> {locked}
    </Alert>
  ) : (
    <Alert kind="warning">
      <strong>本番環境の復元が開いています</strong>（RESTORE_UNLOCK_UNTIL：
      {env.RESTORE_UNLOCK_UNTIL}
      ）。終わったら運用担当に消してもらってください。
    </Alert>
  );
}

function Preview(props: {
  preview: RestorePreview;
  errors: FormErrors;
  values: { confirmation: string; reason: string };
}) {
  const p = props.preview;
  return (
    <section class="card">
      <h2>{p.confirmationText} の状態に戻す</h2>
      <Alert kind="error">
        戻すと、この日時より後の操作 <strong>{p.operationsAfter} 件</strong>
        （全員の分）がすべて失われます。利用者に操作を止めてもらってから行ってください。
      </Alert>
      {p.recentOperations.length > 0 ? (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>日時</th>
                <th>操作した人</th>
                <th>対象</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {p.recentOperations.map((o) => (
                <tr>
                  <td class="nowrap">{dateTime(o.occurredAt)}</td>
                  <td>{o.employeeName ?? o.employeeId}</td>
                  <td>{auditLabel(AUDIT_ENTITY_LABELS, o.entityType)}</td>
                  <td>{auditLabel(AUDIT_ACTION_LABELS, o.action)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.operationsAfter > p.recentOperations.length ? (
            <p class="hint">
              新しいものから {p.recentOperations.length} 件を出しています。すべては
              <a href={paths.auditLogs({ dateFrom: p.confirmationText.slice(0, 10) })}>操作履歴</a>
              で見られます。
            </p>
          ) : null}
        </div>
      ) : (
        <p class="muted">この日時より後の操作はありません。</p>
      )}
      <form method="post" action={paths.restore()} class="form">
        <FormKey />
        <input type="hidden" name="targetAt" value={p.confirmationText} />
        <Field
          label={`確認のため、戻す日時「${p.confirmationText}」を入力してください`}
          name="confirmation"
          required
          error={props.errors["confirmation"]}
        >
          <Input
            name="confirmation"
            value={props.values.confirmation}
            placeholder={p.confirmationText}
            maxlength={40}
          />
        </Field>
        <Field label="理由" name="reason" required error={props.errors["reason"]}>
          <TextArea name="reason" value={props.values.reason} rows={2} />
        </Field>
        <div class="form-actions">
          <button type="submit" class="btn btn-danger">
            業務 DB をこの日時に戻す
          </button>
        </div>
      </form>
    </section>
  );
}

function History(props: { records: readonly RestoreRecord[] }) {
  if (props.records.length === 0) return <EmptyState message="これまでの復元はありません" />;
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>依頼した日時</th>
            <th>戻した日時</th>
            <th>依頼した人</th>
            <th>理由</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {props.records.map((r) => (
            <tr>
              <td class="nowrap">
                <a href={paths.restoreRecord(r.id)}>{dateTime(r.requestedAt)}</a>
              </td>
              <td class="nowrap">{dateTime(r.targetAt)}</td>
              <td>{r.requestedBy.name}</td>
              <td>{r.reason}</td>
              <td>
                <StatusBadge status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function restorePage(
  c: Context<AppEnv>,
  state: {
    at: string;
    preview: Awaited<ReturnType<typeof previewFor>>;
    error?: DomainError | null;
    values?: { confirmation: string; reason: string };
  },
  status: 200 | 403 | 409 | 422 = 200,
) {
  const history = await businessDb(c.env).restoreHistory(c.get("actorRef"));
  const errors = state.error ? toFormErrors(state.error) : {};
  const previewErrors = state.preview && !state.preview.ok ? toFormErrors(state.preview.error) : {};
  return c.html(
    <Layout title="業務 DB の復元" actor={c.get("actor")} current={paths.restore()}>
      <PageHeader title="業務 DB の復元（特定の時点に戻す）">
        <p class="muted">
          誤操作などで業務データを過去30日以内のある時点に戻します。戻すと、その時点より後の操作はすべて失われます（帳票の
          PDF は R2 に残ります）。手順は運用手順書（docs/operations.md 3章）を見てください。
        </p>
      </PageHeader>
      <EnvironmentNotice c={c} />
      <ErrorSummary error={state.error} />
      <form method="get" action={paths.restore()} class="filters">
        <Field
          label="戻す日時（日本時間、秒まで）"
          name="at"
          error={previewErrors["targetAt"]}
          hint="誤操作の直前など。操作履歴の日時が手がかりになります"
        >
          <Input name="at" type="datetime-local" step={1} value={state.at} />
        </Field>
        <div class="field">
          <button type="submit" class="btn btn-secondary">
            戻すと失われる操作を確かめる
          </button>
        </div>
      </form>
      {state.preview?.ok ? (
        <Preview
          preview={state.preview.value}
          errors={errors}
          values={state.values ?? { confirmation: "", reason: "" }}
        />
      ) : state.preview ? (
        <ErrorSummary error={state.preview.error} />
      ) : null}
      <section>
        <h2>これまでの復元</h2>
        {history.ok ? <History records={history.value} /> : <ErrorSummary error={history.error} />}
      </section>
    </Layout>,
    status,
  );
}

function previewFor(c: Context<AppEnv>, at: string) {
  return at === "" ? Promise.resolve(null) : runQuery(c, "restore.preview", { targetAt: at });
}

restoreRoutes.get("/", async (c) => {
  const at = (c.req.query("at") ?? "").trim();
  return restorePage(c, { at, preview: await previewFor(c, at) });
});

restoreRoutes.post("/", async (c) => {
  const form = await readForm(c);
  const targetAt = str(form, "targetAt");
  const values = { confirmation: str(form, "confirmation"), reason: str(form, "reason") };
  const requestId = formKey(form);
  const actorRef = c.get("actorRef");
  const scheduled = await businessDb(c.env).restoreToPointInTime(
    actorRef,
    { targetAt, ...values },
    requestId,
  );
  if (!scheduled.ok) {
    const preview = await previewFor(c, targetAt);
    const code = scheduled.error.code;
    const status = code === "validation" ? 422 : code === "forbidden" ? 403 : 409;
    return restorePage(
      c,
      { at: inputValue(targetAt), preview, error: scheduled.error, values },
      status,
    );
  }
  // Durable Object を作り直す。作り直すと、この呼び出しは例外で終わる（終わらなければ記録だけが残る）
  try {
    const restarted = await businessDb(c.env).restartForRestore(actorRef, scheduled.value.id);
    if (!restarted.ok) log("warn", "restore restart refused", { error: restarted.error.message });
  } catch {
    // 作り直したことによる例外（想定どおり）
  }
  // 作り直した後の業務 DB（新しい接続）で、戻ったことを記録する
  await businessDb(c.env).completeRestore(actorRef, scheduled.value.id);
  return c.redirect(paths.restoreRecord(scheduled.value.id), 303);
});

restoreRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const found = await businessDb(c.env).restoreRecord(c.get("actorRef"), id);
  if (!found.ok) return c.text(found.error.message, 403);
  const r = found.value;
  if (!r) return c.notFound();
  return c.html(
    <Layout title="業務 DB の復元" actor={c.get("actor")} current={paths.restore()}>
      <PageHeader title="業務 DB の復元の記録" />
      {r.status === "restored" ? (
        <Alert kind="success">
          業務 DB を {dateTime(r.targetAt)}{" "}
          の状態に戻しました。画面で取引先・帳票などが戻ったことを確かめてください。
        </Alert>
      ) : (
        <Alert kind="warning">
          復元を予約しましたが、まだ戻ったことを確かめられていません。少し待ってから「戻ったか確かめる」を押してください。
          <form method="post" action={paths.restoreComplete(r.id)} class="inline">
            <FormKey />
            <button type="submit" class="btn btn-secondary btn-sm">
              戻ったか確かめる
            </button>
          </form>
        </Alert>
      )}
      <section class="card">
        <DescriptionList
          items={[
            ["状態", <StatusBadge status={r.status} />],
            ["戻した日時", dateTime(r.targetAt)],
            ["依頼した日時", dateTime(r.requestedAt)],
            ["依頼した人", `${r.requestedBy.name}（${r.requestedBy.email}）`],
            ["理由", r.reason],
            ["環境", r.environment],
            ["戻ったことを確かめた日時", r.completedAt ? dateTime(r.completedAt) : null],
            ["取り消し用のブックマーク", <code class="small">{r.undoBookmark}</code>],
          ]}
        />
      </section>
      <p>
        <a href={paths.restore()}>業務 DB の復元に戻る</a>
      </p>
    </Layout>,
  );
});

restoreRoutes.post("/:id/complete", async (c) => {
  const id = c.req.param("id");
  const done = await businessDb(c.env).completeRestore(c.get("actorRef"), id);
  if (!done.ok) return c.text(done.error.message, done.error.code === "not_found" ? 404 : 403);
  return c.redirect(paths.restoreRecord(id), 303);
});
