import type { WriteMeta } from "../ports";

/** 名前と表示順だけを持つマスタ（ジャンル・払い出し先店舗） */
export interface SimpleMasterFields {
  readonly name: string;
  readonly displayOrder: number;
}

export interface SimpleMasterRecord extends SimpleMasterFields {
  readonly id: string;
  readonly archived: boolean;
  readonly version: number;
  readonly updatedAt: string;
}

/** 選択肢（取引終了を除き、表示順に並べる） */
export interface MasterOption {
  readonly id: string;
  readonly name: string;
}

export interface SimpleMasterStore {
  get(id: string): SimpleMasterRecord | undefined;
  /** 表示順・名前の順 */
  list(includeArchived: boolean): SimpleMasterRecord[];
  options(): MasterOption[];
  findByName(name: string): SimpleMasterRecord | undefined;
  insert(id: string, fields: SimpleMasterFields, meta: WriteMeta): void;
  /** 版番号が一致したときだけ更新する。更新できたら true */
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<SimpleMasterFields & { archived: boolean }>,
    meta: WriteMeta,
  ): boolean;
}
