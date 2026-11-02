/**
 * 帳票のテンプレートの一覧（要件定義書 3.10：帳票は JSX で HTML を作り、Browser Rendering で PDF にする）。
 *
 * 帳票を追加する手順：
 * 1. 発行するユースケースの側（usecases/<区分>/）に、帳票の内容（スナップショット）の zod スキーマを書く。
 *    発行するときは、そのスキーマの形の値を ctx.documents.issue({ snapshot }) に渡す
 * 2. web/views/documents/<帳票>.tsx に defineTemplate({ schema, render })（define-template.ts）でテンプレートを書く。
 *    共通の部品は parts.tsx、レイアウトと CSS は layout.tsx にある。テンプレートは値を表示するだけで、金額を計算しない
 * 3. 下の documentTemplates に1行で登録する
 *
 * テンプレートが登録されていない帳票や、スナップショットがスキーマに合わない帳票は、PDF 化の処理が失敗し、
 * 帳票の画面と処理の記録に理由が残る。
 */
import { jsx } from "hono/jsx";

import {
  DOCUMENT_TYPE_LABELS,
  type DocumentType,
  type Orientation,
} from "../../../domain/documents";
import { err, ok, type Result } from "../../../domain/result";
import type { DocumentMeta, DocumentTemplate, RenderedSheet } from "./define-template";
import { PrintDocument } from "./layout";
import { purchaseOrderTemplate } from "./purchase-order";

// テンプレートの定義（defineTemplate）は define-template.ts にある。テンプレートのファイルはそちらを読み込む
// （ここを読み込むと、テンプレートの一覧との間で循環する）
export {
  defineTemplate,
  type DocumentMeta,
  type DocumentTemplate,
  type RenderedSheet,
} from "./define-template";

/**
 * 帳票の種類 → テンプレート。帳票を追加する区分が1行ずつ登録する。
 * 例：purchase_order: purchaseOrderTemplate,（仕入）、delivery_note: deliveryNoteTemplate,（販売）、
 *     invoice: invoiceTemplate,・credit_note: creditNoteTemplate,（請求）
 */
export const documentTemplates: Partial<Record<DocumentType, DocumentTemplate>> = {
  purchase_order: purchaseOrderTemplate,
};

export interface DocumentSource {
  readonly meta: DocumentMeta;
  readonly snapshot: unknown;
}

export interface RenderedHtml {
  readonly html: string;
  /** 1枚目の用紙の向き（PDF 化の初期値に使う。2枚目以降は CSS の @page で切り替える） */
  readonly orientation: Orientation;
}

/** 帳票（1件または複数件）を、印刷用の1つの HTML にする */
export async function renderDocumentsHtml(
  sources: readonly DocumentSource[],
  title?: string,
): Promise<Result<RenderedHtml>> {
  const sheets: RenderedSheet[] = [];
  for (const source of sources) {
    const { documentType, number } = source.meta;
    const label = DOCUMENT_TYPE_LABELS[documentType];
    const template = documentTemplates[documentType];
    if (!template) {
      return err(
        "not_found",
        `${label}のテンプレートが登録されていないため、PDF を作れません（管理者に連絡してください）`,
      );
    }
    const sheet = template.sheet(source.snapshot, source.meta);
    if (!sheet.ok) {
      return err(sheet.error.code, `${label}（${number}）：${sheet.error.message}`, {
        details: sheet.error.details ?? [],
      });
    }
    sheets.push(sheet.value);
  }
  const first = sheets[0];
  if (!first) return err("validation", "帳票がありません");
  const node = jsx(PrintDocument, { title: title ?? first.title, sheets });
  const html = await node.toString();
  return ok({ html: `<!DOCTYPE html>${html}`, orientation: first.orientation });
}
