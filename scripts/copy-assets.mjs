// 画面で使う外部ライブラリを public/assets/vendor にコピーする（CDN を使わない）
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = resolve(root, "public/assets/vendor");
mkdirSync(vendor, { recursive: true });
copyFileSync(
  resolve(root, "node_modules/htmx.org/dist/htmx.min.js"),
  resolve(vendor, "htmx.min.js"),
);
console.log("copied htmx.min.js");
