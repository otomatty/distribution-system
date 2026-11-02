/**
 * 発送リストと入荷予定一覧のオフライン閲覧（要件定義書 7章「倉庫の通信」の Should）の画面側の目印。
 * service worker（public/sw.js）の動きは E2E（tests/e2e/offline.spec.ts）で確かめる。
 */
import { describe, expect, it } from "vitest";

import { anonymous, as, createEmployee } from "./helpers";

describe("オフライン閲覧の目印", () => {
  it("発送リストと入荷予定一覧の結果の欄に、目印と読み込んだ時刻を出す（絞り込みの部分の差し替えでも更新される）", async () => {
    const user = await createEmployee(["sales"]);
    for (const path of ["/shipping", "/receiving"]) {
      const html = await (await as(user).get(path)).text();
      expect(html).toContain(`data-offline-snapshot="live" data-offline-scope="${path}"`);
      expect(html).toMatch(
        /読み込んだ時刻：<time datetime="[^"]+">\d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/time>/,
      );
      const results = path === "/shipping" ? 'id="shipping-results"' : 'id="results"';
      const marker = html.indexOf("data-offline-snapshot");
      expect(html.lastIndexOf(results, marker)).toBeGreaterThan(0);
    }
    // ほかの画面には出さない（service worker を登録しない）
    expect(await (await as(user).get("/sales-orders")).text()).not.toContain(
      "data-offline-snapshot",
    );
  });

  it("ログアウトの後のログイン画面は、下書きと一緒に残した画面も消す目印を持つ", async () => {
    const html = await (await anonymous().get("/login?logged_out=1")).text();
    expect(html).toContain('data-clear-drafts="true"');
    expect(html).toContain('src="/assets/app.js"');
  });
});
