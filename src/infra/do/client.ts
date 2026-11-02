import type { BusinessDb } from "./business-db";

/** 業務 DB の Durable Object（業務データは1つのオブジェクト "main" にまとめる） */
export function businessDb(env: Env): DurableObjectStub<BusinessDb> {
  const ns = env.BUSINESS_DB;
  return ns.get(ns.idFromName("main"));
}
