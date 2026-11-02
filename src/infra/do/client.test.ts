import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { businessDb } from "./client";

describe("業務 DB の Durable Object の呼び出し", () => {
  it("名前 main のオブジェクトを、北東アジア（apac-ne）の配置の指定つきで呼ぶ", () => {
    const calls: unknown[][] = [];
    const namespace = {
      idFromName: (name: string) => `id:${name}`,
      get: (...args: unknown[]) => {
        calls.push(args);
        return "stub";
      },
    };
    const stub: unknown = businessDb({
      ...env,
      BUSINESS_DB: namespace as unknown as Env["BUSINESS_DB"],
    });
    expect(stub).toBe("stub");
    expect(calls).toEqual([["id:main", { locationHint: "apac-ne" }]]);
  });
});
