/**
 * 帳票のテンプレートの一覧（要件定義書 3.10：帳票は JSX で HTML を作り、Browser Rendering で PDF にする）。
 *
 * 帳票を追加する手順：
 * 1. 発行するユースケースの側（usecases/<区分>/）に、帳票の内容（スナップショット）の zod スキーマを書く。
 *    発行するときは、そのスキーマの形の値を ctx.documents.issue({ snapshot }) に渡す
 * 2. web/views/documents/<帳票>.tsx に defineTemplate({ schema, render }) でテンプレートを書く。
 *    共通の部品は parts.tsx、レイアウトと CSS は layout.tsx にある。テンプレートは値を表示するだけで、金額を計算しない
 * 3. 下の documentTemplates に1行で登録する
 *
 * テンプレートが登録されていない帳票や、スナップショットがスキーマに合わない帳票は、PDF 化の処理が失敗し、
 * 帳票の画面と処理の記録に理由が残る。
 */
import { jsx, type Child } from "hono/jsx";
import type { z } from "zod";

import {
  DOCUMENT_TYPE_LABELS,
  type DocumentType,
  type Orientation,
} from "../../../domain/documents";
import { err, ok, type Result } from "../../../domain/result";
import { PrintDocument, type PrintSheet } from "./layout";

/** 帳票の索引の値（スナップショットの外にある、番号と取引年月日） */
export interface DocumentMeta {
  readonly documentType: DocumentType;
  readonly number: string;
  readonly transactionDate: string;
}

export interface RenderedSheet extends PrintSheet {
  readonly title: string;
}

export interface DocumentTemplate {
  /** スナップショットを検証して、帳票1枚分の中身を作る。スキーマに合わなければ失敗 */
  sheet(snapshot: unknown, meta: DocumentMeta): Result<RenderedSheet>;
}

export function defineTemplate<S extends z.ZodType>(def: {
  /** 発行するユースケースの側で定義したスナップショットのスキーマ */
  readonly schema: S;
  /** 用紙の向き。初期値は縦 */
  readonly orientation?: Orientation;
  /** HTML の <title>。初期値は「請求書 INV-2026-000001」 */
  readonly title?: (data: z.output<S>, meta: DocumentMeta) => string;
  readonly render: (data: z.output<S>, meta: DocumentMeta) => Child;
}): DocumentTemplate {
  return {
    sheet(snapshot, meta) {
      const parsed = def.schema.safeParse(snapshot);
      if (!parsed.success) {
        return err("validation", "帳票の内容がテンプレートの形式と合いません", {
          details: parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.map(String).join(".") || "(全体)"}: ${i.message}`),
        });
      }
      const data = parsed.data;
      return ok({
        title:
          def.title?.(data, meta) ?? `${DOCUMENT_TYPE_LABELS[meta.documentType]} ${meta.number}`,
        orientation: def.orientation ?? "portrait",
        body: def.render(data, meta),
      });
    },
  };
}

/**
 * 帳票の種類 → テンプレート。帳票を追加する区分が1行ずつ登録する。
 * 例：purchase_order: purchaseOrderTemplate,（仕入）、delivery_note: deliveryNoteTemplate,（販売）、
 *     invoice: invoiceTemplate,・credit_note: creditNoteTemplate,（請求）
 */
export const documentTemplates: Partial<Record<DocumentType, DocumentTemplate>> = {};

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
