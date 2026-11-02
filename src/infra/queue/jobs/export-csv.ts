/**
 * CSV の非同期出力（export_csv）。件数の多い一覧の CSV を、依頼した社員の権限でページごとに照会して作り、
 * R2 の jobs/<処理 ID>/ に保存する（要件定義書 3.13）。定義は web/csv-exports.ts。
 */
import { toBusinessDate } from "../../../domain/dates";
import { exportCsvPayload } from "../../../usecases/platform/job-payloads";
import { CSV_BOM, CSV_CONTENT_TYPE, csvLine } from "../../../web/csv";
import { CSV_MAX_ROWS, CSV_PAGE_SIZE, csvFileName, findCsvExport } from "../../../web/csv-exports";
import type { ActorRef } from "../../do/actor-ref";
import { InfraError } from "../../errors";
import { jobResultKey, putFile } from "../../storage/files";
import { defineJob } from "../job";

export const exportCsvJob = defineJob({
  payload: exportCsvPayload,
  async run({ env, job, payload, progress }) {
    const def = findCsvExport(payload.definition);
    if (!def) {
      throw new InfraError("CSV の出力の定義が見つかりません（管理者に連絡してください）", true, {
        definition: payload.definition,
      });
    }
    // 依頼した社員の権限で照会する（無効にされた社員の依頼は出力しない）
    const actorRef: ActorRef =
      job.createdBy === "system"
        ? { kind: "system" }
        : { kind: "employee", employeeId: job.createdBy };
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [encoder.encode(CSV_BOM + csvLine(def.header))];
    let written = 0;
    let total = 0;
    for (let page = 1; written < CSV_MAX_ROWS; page += 1) {
      const result = await def.page(env, actorRef, payload.input, page, CSV_PAGE_SIZE);
      if (!result.ok) {
        throw new InfraError(`CSV を作れませんでした：${result.error.message}`, true, {
          code: result.error.code,
        });
      }
      if (page === 1) total = Math.min(result.value.total, CSV_MAX_ROWS);
      const rows = result.value.rows.slice(0, CSV_MAX_ROWS - written);
      if (rows.length > 0) chunks.push(encoder.encode(rows.map(csvLine).join("")));
      written += rows.length;
      await progress(written, total);
      if (rows.length < CSV_PAGE_SIZE || written >= total) break;
    }
    const fileName = csvFileName(def, toBusinessDate(new Date()));
    const key = jobResultKey(job.id, fileName);
    await putFile(env.FILES, key, new Blob(chunks), { contentType: CSV_CONTENT_TYPE, fileName });
    return { resultKey: key, resultName: fileName };
  },
});
