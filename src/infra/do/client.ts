import type { BusinessDb } from "./business-db";

/**
 * Durable Object の配置（要件定義書 7章：Durable Objects・D1・R2 は「アジア太平洋」の配置を指定する）。
 * Durable Objects はアジア太平洋の中でも日本に近い「北東アジア」（apac-ne：日本・韓国など）を指定する。
 * 配置の指定はオブジェクトを最初に作るときだけ効き、作った後は移らない（指定は目安で、日本国内は保証されない）
 */
const LOCATION_HINT = "apac-ne" satisfies DurableObjectLocationHint;

/** 業務 DB の Durable Object（業務データは1つのオブジェクト "main" にまとめる） */
export function businessDb(env: Env): DurableObjectStub<BusinessDb> {
  const ns = env.BUSINESS_DB;
  return ns.get(ns.idFromName("main"), { locationHint: LOCATION_HINT });
}
