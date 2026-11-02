import type { EmployeeStore } from "./employees.port";
import type { PartnerStore } from "./partners.port";
import type { SettingsStore } from "./settings.port";

/** マスタのポート。実装は infra/db/stores/masters */
export interface MastersStores {
  readonly employees: EmployeeStore;
  readonly partners: PartnerStore;
  readonly settings: SettingsStore;
}
