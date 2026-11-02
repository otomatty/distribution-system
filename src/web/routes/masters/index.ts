/** マスタの画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { employeeRoutes } from "./employees";
import { itemImportRoutes } from "./item-import";
import { itemRoutes } from "./items";
import { locationRoutes } from "./locations";
import { partnerRoutes } from "./partners";
import { settingsRoutes } from "./settings";
import { simpleMasterRoutes } from "./simple-masters";

export const mastersRoutes = new Hono<AppEnv>();

mastersRoutes.route("/partners", partnerRoutes);
// 商品の CSV 一括登録は /items/:id より先に取り付ける
mastersRoutes.route("/items/import", itemImportRoutes);
mastersRoutes.route("/items", itemRoutes);
mastersRoutes.route("/masters/locations", locationRoutes);
mastersRoutes.route(
  "/masters/stores",
  simpleMasterRoutes({
    label: "払い出し先店舗",
    hint: "在庫を払い出す自社店舗。店舗の在庫は管理せず、払い出した時点で在庫から外します。",
    // 権限表：保管場所・払い出し先店舗のマスタは管理者
    permission: "locations.manage",
    names: {
      create: "retailStores.create",
      update: "retailStores.update",
      archive: "retailStores.archive",
      list: "retailStores.list",
      get: "retailStores.get",
    },
    paths: {
      list: paths.stores,
      create: paths.storeNew,
      detail: paths.store,
      archive: paths.storeArchive,
    },
  }),
);
mastersRoutes.route(
  "/masters/genres",
  simpleMasterRoutes({
    label: "ジャンル",
    hint: "商品の分類。商品の検索と在庫一覧の絞り込みに使います。",
    // 権限表：商品マスタ・ジャンルは仕入担当と管理者
    permission: "items.manage",
    names: {
      create: "genres.create",
      update: "genres.update",
      archive: "genres.archive",
      list: "genres.list",
      get: "genres.get",
    },
    paths: {
      list: paths.genres,
      create: paths.genreNew,
      detail: paths.genre,
      archive: paths.genreArchive,
    },
  }),
);
mastersRoutes.route("/admin/employees", employeeRoutes);
mastersRoutes.route("/admin/settings", settingsRoutes);
