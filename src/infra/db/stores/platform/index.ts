import type { PlatformStores } from "../../../../usecases/platform/stores";
import type { Db } from "../../client";

/** 共通の仕組み（帳票・送付・処理状況・CSV・バックアップ・ダッシュボード）のポートの実装をまとめる */
export function createPlatformStores(db: Db): PlatformStores {
  void db;
  return {};
}
