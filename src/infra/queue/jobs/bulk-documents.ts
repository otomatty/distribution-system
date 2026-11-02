/**
 * 一括 PDF（bulk_documents）。帳票をまとめて1つの PDF にし、処理状況の画面からダウンロードできるようにする
 * （要件定義書 3.9）。まだ PDF がない帳票はその場で作る。
 * PDF にできない開発環境（HTML のまま保存）では、1つの HTML にまとめる。
 */
import { bulkDocumentsPayload } from "../../../usecases/platform/job-payloads";
import { renderDocumentsHtml, type DocumentSource } from "../../../web/views/documents/registry";
import { InfraError } from "../../errors";
import { pdfMerger } from "../../pdf/merge";
import { HTML_CONTENT_TYPE, isPdf, PDF_CONTENT_TYPE } from "../../pdf/render";
import { jobResultKey, putFile, readFile } from "../../storage/files";
import { defineJob } from "../job";
import { documentSource, ensureRendered } from "./render-document";

/** ファイル名に使えない文字を置き換える */
function fileBaseName(name: string): string {
  return name.replaceAll(/[\\/:*?"<>|]/g, "_").trim() || "帳票";
}

export const bulkDocumentsJob = defineJob({
  payload: bulkDocumentsPayload,
  async run({ env, db, job, payload, progress }) {
    const ids = payload.documentIds;
    await progress(0, ids.length);
    const merger = await pdfMerger();
    const sources: DocumentSource[] = [];
    let allPdf = true;
    for (const [i, id] of ids.entries()) {
      const file = await ensureRendered(env, db, id);
      sources.push(documentSource(file.doc));
      if (allPdf) {
        const content = await readFile(env.FILES, file.key);
        if (!content) throw new InfraError("保存した PDF が見つかりません", false, { id });
        if (isPdf(content)) await merger.add(content);
        else allPdf = false;
      }
      await progress(i + 1);
    }

    const base = fileBaseName(payload.name);
    let output: { bytes: Uint8Array; contentType: string; fileName: string };
    if (allPdf) {
      output = {
        bytes: await merger.save(),
        contentType: PDF_CONTENT_TYPE,
        fileName: `${base}.pdf`,
      };
    } else {
      const rendered = await renderDocumentsHtml(sources, base);
      if (!rendered.ok) throw new InfraError(rendered.error.message, true);
      output = {
        bytes: new TextEncoder().encode(rendered.value.html),
        contentType: HTML_CONTENT_TYPE,
        fileName: `${base}.html`,
      };
    }
    const key = jobResultKey(job.id, output.fileName);
    await putFile(env.FILES, key, output.bytes, {
      contentType: output.contentType,
      fileName: output.fileName,
    });
    return { resultKey: key, resultName: output.fileName };
  },
});
