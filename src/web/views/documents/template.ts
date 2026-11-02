/**
 * 帳票のテンプレートの定義（defineTemplate）。テンプレートの一覧は registry.ts。
 * テンプレートのファイル（delivery-note.tsx など）はここを import し、registry.ts がテンプレートを import する。
 */
import type { Child } from "hono/jsx";
import type { z } from "zod";

import {
  DOCUMENT_TYPE_LABELS,
  type DocumentType,
  type Orientation,
} from "../../../domain/documents";
import { err, ok, type Result } from "../../../domain/result";
import type { PrintSheet } from "./layout";

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
