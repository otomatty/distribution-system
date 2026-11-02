/**
 * 操作履歴（要件定義書 7章 セキュリティ：状態を変える操作はすべて、誰が・いつ・何を・変更前後の値を記録し、
 * 管理者が検索できる）。記録の対象と操作の表示名と、変更前後の値から項目ごとの変更を作る規則。
 */

/** 記録の対象（audit_logs.entity_type）の表示名 */
export const AUDIT_ENTITY_LABELS: Readonly<Record<string, string>> = {
  purchase_order: "発注",
  receipt: "入荷",
  purchase_return: "仕入返品",
  supplier_invoice: "仕入先請求書",
  sales_order: "受注",
  shipment: "発送",
  invoice: "請求書",
  sales_return: "返品伝票",
  customer_payment: "入金",
  disposal: "販売先廃棄",
  stock_operation: "在庫操作",
  item: "商品",
  item_import: "商品の一括登録",
  partner: "取引先",
  location: "保管場所",
  retail_store: "払い出し先店舗",
  genre: "ジャンル",
  employee: "社員",
  company_settings: "自社設定",
  tax_rate: "税率",
  document: "帳票",
  job: "処理",
  business_db: "業務 DB",
};

/** 操作（audit_logs.action）の表示名 */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  create: "登録",
  update: "更新",
  delete: "削除",
  cancel: "取消",
  confirm: "確定",
  receive: "入荷の記録",
  cancel_receipt: "入荷の取消",
  ship: "発送",
  cancel_shipment: "発送の取消",
  split: "分割",
  create_by_split: "分割で作成",
  allocate: "消込",
  cancel_allocation: "消込の取消",
  pay: "支払",
  cancel_payment: "支払・入金の取消",
  detach_receipt: "入荷の切り離し",
  detach_return: "仕入返品の切り離し",
  cancel_purchase_return: "仕入返品の取消",
  attach_pdf: "PDF の添付",
  issue: "発行",
  reissue: "再発行",
  cancel_for_reissue: "再発行のための取消",
  issue_credit_note: "返還請求書の発行",
  import: "一括登録",
  stocktake: "棚卸",
  update_memo: "メモの更新",
  update_terms: "取引条件の更新",
  discontinue: "取扱終了",
  resume: "取扱終了の取消",
  archive: "取引終了・利用終了",
  unarchive: "取引終了・利用終了の取消",
  send_email: "メールで送付",
  retry_send: "送付のやり直し",
  rerender: "PDF の作り直し",
  record_manual_send: "手動の送付の記録",
  enqueue_bulk_documents: "一括 PDF の受付",
  enqueue_bulk_delivery_notes: "納品書の一括 PDF の受付",
  enqueue_csv_export: "CSV 出力の受付",
  link_auth_user: "Google アカウントとの連携",
  point_in_time_restore: "特定の時点への復元",
};

/** 表示名。登録されていない値はそのまま出す */
export function auditLabel(labels: Readonly<Record<string, string>>, value: string): string {
  return labels[value] ?? value;
}

/** 項目ごとの変更。値がなかった（記録されていない）ときは null */
export interface AuditChange {
  /** 項目の名前（入れ子は「.」、配列は「[番号]」でつなぐ。例：lines[0].quantity） */
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface AuditChanges {
  readonly changes: readonly AuditChange[];
  /** 上限を超えて省いた変更の数 */
  readonly omitted: number;
}

const MAX_DEPTH = 4;

function leafText(value: unknown): string {
  if (value === null || value === "") return "（空）";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "はい" : "いいえ";
  if (typeof value === "number") return String(value);
  // 入れ子が深すぎるもの・空のオブジェクト
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 値を「項目の名前 → 表示する文字列」に平らにする */
function flatten(value: unknown, path: string, depth: number, out: Map<string, string>): void {
  const join = (key: string) => (path === "" ? key : `${path}.${key}`);
  if (Array.isArray(value) && value.length > 0 && depth < MAX_DEPTH) {
    value.forEach((v, i) => flatten(v, `${path}[${i}]`, depth + 1, out));
  } else if (isRecord(value) && Object.keys(value).length > 0 && depth < MAX_DEPTH) {
    for (const [k, v] of Object.entries(value)) flatten(v, join(k), depth + 1, out);
  } else if (Array.isArray(value) && value.length === 0) {
    out.set(path, "（なし）");
  } else {
    out.set(path, leafText(value));
  }
}

function flat(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (value !== undefined) flatten(value, "", 0, out);
  return out;
}

/** 最初の項目の名前（lines[0].quantity → lines） */
function topKey(path: string): string {
  const end = path.search(/[.[]/);
  return end === -1 ? path : path.slice(0, end);
}

/**
 * 変更前後の値（記録した JSON を読み戻したもの。記録がなければ undefined）から、項目ごとの変更を作る。
 * - 両方あるとき：変更後に記録した項目（最初の名前が同じもの）だけを比べ、値が変わったものを出す。
 *   変更前は伝票全体、変更後は変えた項目だけを記録することが多いため（版番号や作成日時は比べない）
 * - 変更後だけ（登録など）・変更前だけ（削除など）：記録した項目をすべて出す
 */
export function auditChanges(before: unknown, after: unknown, limit = 50): AuditChanges {
  const b = flat(before);
  const a = flat(after);
  let changes: AuditChange[];
  if (before === undefined || after === undefined) {
    const source = after === undefined ? b : a;
    changes = [...source].map(([path, text]) => ({
      path,
      before: after === undefined ? text : null,
      after: after === undefined ? null : text,
    }));
  } else {
    const keys = new Set([...a.keys()].map(topKey));
    const paths = [...new Set([...a.keys(), ...[...b.keys()].filter((p) => keys.has(topKey(p)))])];
    changes = paths.flatMap((path) => {
      const was = b.get(path) ?? null;
      const now = a.get(path) ?? null;
      return was === now ? [] : [{ path, before: was, after: now }];
    });
  }
  return { changes: changes.slice(0, limit), omitted: Math.max(0, changes.length - limit) };
}

/** 記録した JSON を読み戻す。記録がなければ undefined、JSON として読めなければ文字列のまま */
export function parseAuditJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return text;
  }
}
