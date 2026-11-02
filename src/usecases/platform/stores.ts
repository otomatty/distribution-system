import type { DocumentStore } from "./documents.port";
import type { JobStore } from "./jobs.port";

/** 共通の仕組み（帳票・送付・処理状況・CSV・バックアップ・ダッシュボード）のポート。実装は infra/db/stores/platform */
export interface PlatformStores {
  readonly documents: DocumentStore;
  readonly jobs: JobStore;
}
