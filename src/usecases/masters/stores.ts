import type { EmployeeStore } from "./employees.port";
import type { ItemStore } from "./items.port";
import type { LocationStore } from "./locations.port";
import type { PartnerStore } from "./partners.port";
import type { SettingsStore } from "./settings.port";
import type { SimpleMasterStore } from "./simple-masters.port";

/** マスタのポート。実装は infra/db/stores/masters */
export interface MastersStores {
  readonly employees: EmployeeStore;
  readonly partners: PartnerStore;
  readonly settings: SettingsStore;
  readonly items: ItemStore;
  readonly locations: LocationStore;
  readonly genres: SimpleMasterStore;
  /** 払い出し先店舗（自社店舗。在庫は管理しない） */
  readonly retailStores: SimpleMasterStore;
}
