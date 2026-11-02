/**
 * 帳票の PDF 化（render_document）。発行時点の内容（スナップショット）をテンプレートで HTML にし、
 * Browser Rendering で PDF にして R2 に保存する（要件定義書 3.10）。
 * 送付・一括 PDF からも ensureRendered を呼び、まだ PDF がなければその場で作る。
 */
import { documentFileName } from "../../../domain/documents";
import { renderDocumentPayload } from "../../../usecases/platform/job-payloads";
import { renderDocumentsHtml, type DocumentSource } from "../../../web/views/documents/registry";
import type { BusinessDb, DocumentForRender } from "../../do/business-db";
import { InfraError } from "../../errors";
import { HTML_CONTENT_TYPE, PDF_CONTENT_TYPE, renderPdf } from "../../pdf/render";
import { documentKey, fileExists, putFile } from "../../storage/files";
import { defineJob } from "../job";

export interface StoredDocument {
  readonly doc: DocumentForRender;
  readonly key: string;
  readonly contentType: string;
  readonly fileName: string;
}

function parseSnapshot(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export function documentSource(doc: DocumentForRender): DocumentSource {
  return {
    meta: {
      documentType: doc.documentType,
      number: doc.number,
      transactionDate: doc.transactionDate,
    },
    snapshot: parseSnapshot(doc.snapshotJson),
  };
}

function stored(doc: DocumentForRender, key: string): StoredDocument {
  const pdf = key.endsWith(".pdf");
  return {
    doc,
    key,
    contentType: pdf ? PDF_CONTENT_TYPE : HTML_CONTENT_TYPE,
    fileName: documentFileName(doc.documentType, doc.number, pdf ? "pdf" : "html"),
  };
}

/**
 * 帳票の PDF を用意する。作成済みならそれを使い、なければ作って R2 に保存する。
 * 何度呼んでも同じ結果になる（再試行や、PDF 化と送付が同時に動いた場合に備える）。
 * R2 の帳票はバケットロックで上書きできないので、すでにあるファイルは書き直さない。
 */
export async function ensureRendered(
  env: Env,
  db: DurableObjectStub<BusinessDb>,
  documentId: string,
): Promise<StoredDocument> {
  const doc = await db.documentForRender(documentId);
  if (!doc) throw new InfraError("帳票が見つかりません", true, { documentId });
  if (doc.status === "ready" && doc.r2Key && (await fileExists(env.FILES, doc.r2Key))) {
    return stored(doc, doc.r2Key);
  }
  const rendered = await renderDocumentsHtml([documentSource(doc)]);
  if (!rendered.ok) {
    throw new InfraError(rendered.error.message, true, {
      documentId,
      details: rendered.error.details ?? [],
    });
  }
  const file = await renderPdf(env, rendered.value.html, {
    orientation: rendered.value.orientation,
  });
  const key = documentKey(
    doc.documentType,
    doc.transactionDate,
    doc.number,
    doc.id,
    file.extension,
  );
  const result = stored(doc, key);
  if (!(await fileExists(env.FILES, key))) {
    await putFile(env.FILES, key, file.bytes, {
      contentType: file.contentType,
      fileName: result.fileName,
    });
  }
  await db.documentRendered(doc.id, key);
  return result;
}

export const renderDocumentJob = defineJob({
  payload: renderDocumentPayload,
  async run({ env, db, payload }) {
    const result = await ensureRendered(env, db, payload.documentId);
    return { resultKey: result.key, resultName: result.fileName };
  },
  async onFailed({ db, payload }) {
    await db.documentRenderFailed(payload.documentId);
  },
});
