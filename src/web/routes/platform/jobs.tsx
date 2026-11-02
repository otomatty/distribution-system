/**
 * 処理状況（一括 PDF・大きな CSV の進み具合とダウンロード、要件定義書 5章）。
 * 本人が依頼したものを表示する（管理者はすべてと日次バックアップ）。
 * 終わっていない行は2秒ごとにその行だけを読み直し、終わったら読み直しをやめる。
 */
import { Hono } from "hono";

import {
  isJobActive,
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  progressPercent,
  type JobStatus,
} from "../../../domain/jobs";
import { fileResponse } from "../../../infra/storage/files";
import type { JobView } from "../../../usecases/platform/jobs.port";
import { isHtmx } from "../../http";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runQuery } from "../../usecase";
import { Alert, Badge, EmptyState, PageHeader, Select } from "../../views/components";
import { PRINT_CSP } from "../../views/documents/layout";
import { dateTime } from "../../views/format";
import { Layout } from "../../views/layout";

export const jobRoutes = new Hono<AppEnv>();

const NOTICES: Readonly<Record<string, string>> = {
  bulk: "一括 PDF の作成を受け付けました。できあがったら、この画面からダウンロードできます",
  csv: "件数が多いため、CSV をあとで作成します。できあがったら、この画面からダウンロードできます",
};

const STATUS_KIND: Readonly<Record<JobStatus, "neutral" | "info" | "success" | "danger">> = {
  pending: "neutral",
  queued: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
};

function JobRow(props: { job: JobView }) {
  const j = props.job;
  const active = isJobActive(j.status);
  const percent = progressPercent(j.status, j.progress, j.total);
  return (
    <tr
      id={`job-${j.id}`}
      class={j.status === "failed" ? "row-danger" : undefined}
      {...(active
        ? { "hx-get": paths.job(j.id), "hx-trigger": "every 2s", "hx-swap": "outerHTML" }
        : {})}
    >
      <td>{JOB_TYPE_LABELS[j.type]}</td>
      <td class="nowrap">{dateTime(j.createdAt)}</td>
      <td>{j.createdByName ?? (j.createdBy === "system" ? "システム" : "")}</td>
      <td>
        <Badge kind={STATUS_KIND[j.status]}>{JOB_STATUS_LABELS[j.status]}</Badge>
      </td>
      <td>
        <progress class="progress-bar" max={100} value={percent} aria-label="進み具合">
          {percent}%
        </progress>
        <div class="small muted">
          {j.total > 0 ? `${j.progress} / ${j.total}件` : active ? "準備中" : ""}
        </div>
      </td>
      <td>
        {j.status === "succeeded" && j.resultKey ? (
          <a class="btn btn-secondary btn-sm" href={paths.jobDownload(j.id)}>
            ダウンロード
          </a>
        ) : null}
        {j.status === "failed" ? <span class="small">{j.error ?? "失敗しました"}</span> : null}
      </td>
    </tr>
  );
}

function JobTable(props: { jobs: readonly JobView[] }) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>処理</th>
            <th>依頼日時</th>
            <th>依頼した人</th>
            <th>状態</th>
            <th>進み具合</th>
            <th>結果</th>
          </tr>
        </thead>
        <tbody>
          {props.jobs.map((j) => (
            <JobRow job={j} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

jobRoutes.get("/", async (c) => {
  const statusParam = c.req.query("status");
  const status = statusParam === "active" || statusParam === "failed" ? statusParam : undefined;
  const jobs = await runQuery(c, "jobs.list", { status });
  const notice = NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title="処理状況" actor={c.get("actor")} current={paths.jobs()}>
      <PageHeader title="処理状況">
        <p class="muted">
          一括 PDF と、件数の多い CSV の進み具合です。できあがったらダウンロードできます。
        </p>
      </PageHeader>
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <form
        class="filters"
        method="get"
        action={paths.jobs()}
        hx-get={paths.jobs()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <div class="field">
          <label for="f-status">状態</label>
          <Select
            name="status"
            value={status ?? ""}
            empty="すべて"
            options={[
              { value: "active", label: "処理中" },
              { value: "failed", label: "失敗" },
            ]}
          />
        </div>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            表示
          </button>
        </noscript>
      </form>
      <section id="results">
        {jobs.length === 0 ? <EmptyState message="処理はありません" /> : <JobTable jobs={jobs} />}
      </section>
    </Layout>,
  );
});

jobRoutes.get("/:id", async (c) => {
  const job = await runQuery(c, "jobs.get", { id: c.req.param("id") });
  if (!job) return c.notFound();
  // 進み具合の読み直し（htmx）は行だけを返す
  if (isHtmx(c)) return c.html(<JobRow job={job} />);
  return c.html(
    <Layout title={JOB_TYPE_LABELS[job.type]} actor={c.get("actor")} current={paths.jobs()}>
      <PageHeader title={JOB_TYPE_LABELS[job.type]} />
      <JobTable jobs={[job]} />
      <p>
        <a href={paths.jobs()}>処理状況の一覧に戻る</a>
      </p>
    </Layout>,
  );
});

jobRoutes.get("/:id/download", async (c) => {
  const job = await runQuery(c, "jobs.get", { id: c.req.param("id") });
  if (!job) return c.notFound();
  if (job.status !== "succeeded" || !job.resultKey) {
    return c.text("まだできあがっていません。しばらくしてからもう一度お試しください", 409);
  }
  const response = await fileResponse(
    c.env.FILES,
    job.resultKey,
    job.resultName ?? "download",
    job.resultName?.endsWith(".html") ? { "Content-Security-Policy": PRINT_CSP } : {},
  );
  return response ?? c.text("ファイルが見つかりません。管理者に連絡してください", 404);
});
