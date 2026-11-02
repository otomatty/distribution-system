/**
 * 開発用ログイン（/dev/login と dev_actor の Cookie）は、ENVIRONMENT が development / test のときだけ使える。
 * wrangler.jsonc の既定の値（unconfigured）・検証・本番では使えない（--env なしで配備しても開かない）。
 */
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../../src/worker";
import { ADMIN_EMAIL, ORIGIN } from "./helpers";

async function fetchAs(environment: string, path: string, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(ORIGIN + path, { headers, redirect: "manual" }),
    { ...env, ENVIRONMENT: environment },
    createExecutionContext(),
  );
}

describe("開発用ログイン", () => {
  it("既定の値（unconfigured）・検証・本番では、画面も Cookie も使えない", async () => {
    for (const environment of ["unconfigured", "staging", "production", ""]) {
      expect((await fetchAs(environment, "/dev/login")).status).toBe(404);
      const withCookie = await fetchAs(environment, "/", {
        Cookie: `dev_actor=${encodeURIComponent(ADMIN_EMAIL)}`,
      });
      expect(withCookie.status).toBe(302);
      expect(withCookie.headers.get("Location")).toBe("/login");
      expect(await (await fetchAs(environment, "/login")).text()).not.toContain("開発用ログイン");
    }
  });

  it("テストと開発では使える", async () => {
    for (const environment of ["test", "development"]) {
      expect((await fetchAs(environment, "/dev/login")).status).toBe(200);
      expect(await (await fetchAs(environment, "/login")).text()).toContain("開発用ログイン");
    }
  });
});
