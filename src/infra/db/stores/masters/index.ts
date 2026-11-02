import type { MastersStores } from "../../../../usecases/masters/stores";
import type { Db } from "../../client";
import { employeeStore } from "./employees";
import { partnerStore } from "./partners";
import { settingsStore } from "./settings";

/** マスタのポートの実装をまとめる */
export function createMastersStores(db: Db): MastersStores {
  return {
    employees: employeeStore(db),
    partners: partnerStore(db),
    settings: settingsStore(db),
  };
}
