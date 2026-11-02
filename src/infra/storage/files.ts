/**
 * R2 に置くファイル（帳票の PDF、一括 PDF・CSV などの処理結果、バックアップ）。
 * R2 のファイルは公開せず、権限を確かめた Worker 経由でだけダウンロードさせる（要件定義書 7章 セキュリティ）。
 *
 * 保存先の決まり：
 * - 帳票：documents/<種類>/<取引年>/<番号>-<帳票 ID>.<pdf|html>（バケットロックで7年保持）
 * - 処理結果：jobs/<処理 ID>/<ファイル名>
 * - バックアップ：backups/<YYYY-MM-DD>.json.gz
 */
import type { DocumentType } from "../../domain/documents";

export const DOCUMENTS_PREFIX = "documents/";
export const JOBS_PREFIX = "jobs/";
export const BACKUPS_PREFIX = "backups/";

/** キーに使えない文字を置き換える（番号やファイル名は社内で決めたものだが、念のため） */
function safeSegment(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f || ch === "/" || ch === "\\" ? "_" : ch;
  }
  return out.slice(0, 120);
}

export function documentKey(
  type: DocumentType,
  transactionDate: string,
  number: string,
  documentId: string,
  extension: string,
): string {
  return `${DOCUMENTS_PREFIX}${type}/${transactionDate.slice(0, 4)}/${safeSegment(number)}-${documentId}.${extension}`;
}

export function jobResultKey(jobId: string, fileName: string): string {
  return `${JOBS_PREFIX}${jobId}/${safeSegment(fileName)}`;
}

export function backupKey(date: string): string {
  return `${BACKUPS_PREFIX}${date}.json.gz`;
}

/** バックアップのキーから日付を取り出す（backups/2026-11-02.json.gz → 2026-11-02） */
export function backupDateOf(key: string): string | undefined {
  const m = /^backups\/(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(key);
  return m?.[1];
}

/**
 * Content-Disposition。日本語のファイル名は RFC 5987 の filename* で渡し、
 * 古いソフト向けに ASCII だけの filename も付ける。
 */
export function contentDisposition(
  fileName: string,
  disposition: "attachment" | "inline" = "attachment",
): string {
  const ascii = fileName.replaceAll(/[^\x20-\x7e]/g, "_").replaceAll(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replaceAll(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface StoredFile {
  readonly contentType: string;
  /** ダウンロードするときのファイル名 */
  readonly fileName: string;
}

/** ファイルを保存する。ダウンロードのときに使う種類とファイル名をメタデータに残す */
export async function putFile(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | ArrayBufferView | Blob | string,
  file: StoredFile,
): Promise<void> {
  await bucket.put(key, body, {
    httpMetadata: {
      contentType: file.contentType,
      contentDisposition: contentDisposition(file.fileName),
    },
    customMetadata: { fileName: file.fileName },
  });
}

/** 保存済みか（バケットロックの対象は上書きできないので、書く前に確かめる） */
export async function fileExists(bucket: R2Bucket, key: string): Promise<boolean> {
  return (await bucket.head(key)) !== null;
}

export async function readFile(bucket: R2Bucket, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return new Uint8Array(await object.arrayBuffer());
}

/**
 * 保存したファイルをダウンロードさせる（R2 から読みながら返す）。見つからなければ null。
 * extraHeaders で Content-Security-Policy などを足せる。
 */
export async function fileResponse(
  bucket: R2Bucket,
  key: string,
  fileName: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("Content-Disposition", contentDisposition(fileName));
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}
