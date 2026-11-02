import type { InvoiceLineDraft } from "../../domain/billing";
import type { RenderStatus, SendStatus } from "../../domain/documents";
import type { RoundingMode, TaxCategory } from "../../domain/money";
import type { InvoiceStatus } from "../../domain/sales";
import type { WriteMeta } from "../ports";
import type { Page } from "../schemas";

export interface InvoiceTaxGroup {
  readonly category: TaxCategory;
  readonly rateBps: number;
  readonly subtotal: number;
  readonly tax: number;
}

/** 請求書（発行時点の金額・宛名・自社情報を保存する） */
export interface InvoiceRecord {
  readonly id: string;
  /** 請求書番号（INV-2026-000001） */
  readonly number: string;
  readonly customerId: string;
  readonly issuedOn: string;
  /** 締め期間（月締めの販売先だけ） */
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly dueOn: string | null;
  readonly subtotal: number;
  readonly tax: number;
  readonly total: number;
  readonly taxSummary: readonly InvoiceTaxGroup[];
  readonly roundingMode: RoundingMode;
  readonly recipientSnapshot: Readonly<Record<string, string | null>>;
  readonly issuerSnapshot: Readonly<Record<string, string | null>>;
  /** 消し込んだ入金額と差額の合計 */
  readonly allocated: number;
  readonly status: InvoiceStatus;
  /** 取り消して再発行したときの、元の請求書 */
  readonly reissuedFromId: string | null;
  readonly cancelReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
}

export type InvoiceLineRecord = InvoiceLineDraft;

/** 請求書の帳票（取り消したものも含む、最新のもの） */
export interface InvoiceDocumentRef {
  readonly documentId: string;
  readonly status: RenderStatus;
  readonly cancelled: boolean;
  readonly lastSendStatus: SendStatus | null;
}

export interface InvoiceAllocationRow {
  readonly id: string;
  readonly paymentId: string;
  readonly receivedOn: string;
  readonly method: "transfer" | "cash" | "offset" | "other";
  /** 返還請求書の返還額から消し込んだなら、その返品伝票（普通の入金は null） */
  readonly salesReturnId: string | null;
  readonly amount: number;
  readonly adjustment: number;
  readonly adjustmentKind: "bank_fee" | "discount" | "other" | null;
  readonly cancelled: boolean;
  /** 消込の取消の理由（取り消していなければ null） */
  readonly cancelReason: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface InvoiceDetail extends InvoiceRecord {
  readonly customerName: string;
  readonly reissuedFromNumber: string | null;
  /** この請求書を取り消して再発行した請求書 */
  readonly reissuedTo: readonly { readonly id: string; readonly number: string }[];
  readonly lines: readonly InvoiceLineRecord[];
  /** 載せている発送（取り消した請求書では空。対象の発送は未請求に戻っている） */
  readonly shipments: readonly {
    readonly id: string;
    readonly version: number;
    readonly shippedOn: string;
    readonly deliveryNoteNumber: string;
    readonly salesOrderId: string;
    readonly salesOrderNumber: string;
  }[];
  /** 載せている返品伝票 */
  readonly returns: readonly {
    readonly id: string;
    readonly number: string;
    readonly returnedOn: string;
    readonly salesOrderId: string;
    readonly creditNoteNumber: string | null;
  }[];
  readonly allocations: readonly InvoiceAllocationRow[];
  readonly document: InvoiceDocumentRef | null;
}

export interface InvoiceListRow extends InvoiceRecord {
  readonly customerName: string;
  readonly document: InvoiceDocumentRef | null;
}

export interface InvoiceFilter {
  readonly status?: InvoiceStatus | undefined;
  /** 未入金・一部入金だけ */
  readonly open?: boolean | undefined;
  readonly customerId?: string | undefined;
  readonly issuedFrom?: string | undefined;
  readonly issuedTo?: string | undefined;
  /** この日より前に支払期限を過ぎた、未入金・一部入金の請求書だけ */
  readonly overdueAsOf?: string | undefined;
  /** 請求書番号の部分一致 */
  readonly number?: string | undefined;
  /** 最新の送付の結果 */
  readonly sendStatus?: "failed" | undefined;
  /** 支払期限がこの日まで */
  readonly dueTo?: string | undefined;
  /** 取消済みを除く */
  readonly excludeCancelled?: boolean | undefined;
}

/** 締め日のある販売先と、最も古い未請求の発送日 */
export interface ClosingCustomer {
  readonly id: string;
  readonly name: string;
  readonly kana: string;
  readonly closingDay: number;
  readonly paymentMonthOffset: number;
  readonly paymentDay: number;
  /** 未請求の発送がなければ null */
  readonly oldestUnbilledOn: string | null;
}

export interface InvoiceStore {
  get(id: string): InvoiceDetail | undefined;
  /**
   * 一覧。order が issued なら発行日の新しい順、due なら支払期限の早い順（期限なしは最後）
   */
  list(
    filter: InvoiceFilter,
    order: "issued" | "due",
    page: number,
    pageSize: number,
  ): Page<InvoiceListRow>;
  count(filter: InvoiceFilter): number;
  /** 消込の対象にできる請求書（未入金・一部入金）。指定した販売先の、支払期限の早い順 */
  openForCustomer(customerId: string): InvoiceRecord[];
  insert(
    record: Omit<InvoiceRecord, "version" | "createdAt" | "createdBy" | "updatedAt">,
    lines: readonly (InvoiceLineRecord & { readonly id: string })[],
    meta: WriteMeta,
  ): void;
  /** 版番号が一致したときだけ状態・消込の合計・取消の理由を変え、版番号を上げる。更新できたら true */
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<InvoiceRecord, "status" | "allocated" | "cancelReason">>,
    meta: WriteMeta,
  ): boolean;
  /**
   * 発送を請求書に結びつける（版番号が一致し、未請求で取り消していないものだけ）。結びつけた件数を返す
   */
  attachShipments(
    invoiceId: string,
    shipments: readonly { readonly id: string; readonly version: number }[],
    meta: WriteMeta,
  ): number;
  /** 請求書から発送を外す（未請求に戻す）。外した発送の ID */
  detachShipments(invoiceId: string, meta: WriteMeta): string[];
  attachReturns(
    invoiceId: string,
    returns: readonly { readonly id: string; readonly version: number }[],
    meta: WriteMeta,
  ): number;
  detachReturns(invoiceId: string, meta: WriteMeta): string[];
  /** 締め日のある販売先（取引終了でも未請求の発送があれば含める）。読み仮名の順 */
  closingCustomers(customerId?: string): ClosingCustomer[];
}
