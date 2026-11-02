import type { PaymentMethod, ReceivableSums } from "../../domain/billing";
import type { AllocationAdjustmentKind, InvoiceStatus } from "../../domain/sales";
import type { WriteMeta } from "../ports";
import type { Page } from "../schemas";

/** 入金 */
export interface CustomerPaymentRecord {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly receivedOn: string;
  readonly amount: number;
  readonly method: PaymentMethod;
  readonly memo: string | null;
  readonly cancelled: boolean;
  /** 取消の理由・日時（UTC）・操作者（取り消していなければ null） */
  readonly cancelReason: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledByName: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdByName: string | null;
}

/** 消込（入金 → 請求書） */
export interface AllocationRecord {
  readonly id: string;
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceStatus: InvoiceStatus;
  /** 入金から充てた額 */
  readonly amount: number;
  /** 差額として処理した額 */
  readonly adjustment: number;
  readonly adjustmentKind: AllocationAdjustmentKind | null;
  readonly cancelled: boolean;
  /** 取消の理由と日時（UTC）。入金の取消でまとめて取り消した消込は「入金の取消：（入金の取消の理由）」 */
  readonly cancelReason: string | null;
  readonly cancelledAt: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface CustomerPaymentListRow extends CustomerPaymentRecord {
  /** 有効な消込の、入金から充てた額の合計 */
  readonly allocatedAmount: number;
  readonly allocationCount: number;
}

export interface CustomerPaymentFilter {
  readonly customerId?: string | undefined;
  readonly receivedFrom?: string | undefined;
  readonly receivedTo?: string | undefined;
  /** 未消込の残高がある入金だけ */
  readonly unallocatedOnly?: boolean | undefined;
  readonly includeCancelled?: boolean | undefined;
}

export interface ReceivableRow extends ReceivableSums {
  readonly customerId: string;
  readonly customerName: string;
  readonly openCount: number;
  readonly overdueCount: number;
  /** 未入金・一部入金の請求書で、最も早い支払期限 */
  readonly nextDueOn: string | null;
}

export interface CustomerPaymentStore {
  get(id: string): CustomerPaymentRecord | undefined;
  list(filter: CustomerPaymentFilter, page: number, pageSize: number): Page<CustomerPaymentListRow>;
  insert(
    record: Omit<
      CustomerPaymentRecord,
      | "cancelled"
      | "cancelReason"
      | "cancelledAt"
      | "cancelledByName"
      | "version"
      | "createdAt"
      | "createdByName"
      | "customerName"
    >,
    meta: WriteMeta,
  ): void;
  /** 版番号が一致したときだけ版番号を上げる（消込を足す・外すとき）。更新できたら true */
  touch(id: string, expectedVersion: number, meta: WriteMeta): boolean;
  /** 版番号が一致したときだけ取消済みにする（理由・日時・操作者を記録する）。更新できたら true */
  cancel(id: string, expectedVersion: number, reason: string, meta: WriteMeta): boolean;
  /** 入金の消込（新しい順。取り消したものも含む） */
  allocations(paymentId: string): AllocationRecord[];
  getAllocation(id: string): AllocationRecord | undefined;
  insertAllocations(
    rows: readonly {
      readonly id: string;
      readonly paymentId: string;
      readonly invoiceId: string;
      readonly amount: number;
      readonly adjustment: number;
      readonly adjustmentKind: AllocationAdjustmentKind | null;
    }[],
    meta: WriteMeta,
  ): void;
  /** 版番号が一致したときだけ消込を取消済みにする（理由・日時・操作者を記録する）。更新できたら true */
  cancelAllocation(id: string, expectedVersion: number, reason: string, meta: WriteMeta): boolean;
  /**
   * 販売先ごとの売掛の集計（未入金・一部入金の請求書と、取り消していない入金）。
   * 未入金・一部入金の請求書か、未消込の入金がある販売先だけ。読み仮名の順
   */
  receivables(
    filter: { readonly customerId?: string | undefined; readonly today: string },
    page: number,
    pageSize: number,
  ): Page<ReceivableRow>;
}
