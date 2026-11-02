import type { MastersStores } from "../../../../usecases/masters/stores";
import type { Db } from "../../client";
import { employeeStore } from "./employees";
import { itemStore } from "./items";
import { locationStore } from "./locations";
import { partnerStore } from "./partners";
import { settingsStore } from "./settings";
import { genreStore, retailStoreStore } from "./simple-masters";

/** マスタのポートの実装をまとめる */
export function createMastersStores(db: Db): MastersStores {
  return {
    employees: employeeStore(db),
    partners: partnerStore(db),
    settings: settingsStore(db),
    items: itemStore(db),
    locations: locationStore(db),
    genres: genreStore(db),
    retailStores: retailStoreStore(db),
  };
}
