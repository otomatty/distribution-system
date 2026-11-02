/** web 層から業務 DB のユースケースを呼ぶ（AGENTS.md 2章）。 */
import type { Context } from "hono";

import type { Result } from "../domain/result";
import type { ActorRef } from "../infra/do/actor-ref";
import { businessDb } from "../infra/do/client";
import type {
  CommandInput,
  CommandName,
  CommandOutput,
  QueryInput,
  QueryName,
  QueryOutput,
} from "../usecases/registry";
import type { AppEnv } from "./types";

export async function runCommand<N extends CommandName>(
  c: Context<AppEnv>,
  name: N,
  input: CommandInput<N>,
  idempotencyKey: string | null,
): Promise<Result<CommandOutput<N>>> {
  const result = (await businessDb(c.env).command(
    name,
    input,
    c.get("actorRef"),
    idempotencyKey,
  )) as Result<unknown>;
  // RPC を通ると戻り値の型が unknown になるため、ここで registry の型に戻す。
  // 業務 DB はユースケースの定義どおりの出力を返すので安全（AGENTS.md 4章の例外）
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return result as Result<CommandOutput<N>>;
}

export async function runQuery<N extends QueryName>(
  c: Context<AppEnv>,
  name: N,
  input: QueryInput<N>,
): Promise<QueryOutput<N>> {
  const result = await queryAs(c.env, c.get("actorRef"), name, input);
  if (!result.ok) throw new QueryError(result.error.code, result.error.message);
  return result.value;
}

/**
 * 画面の外（Queues の処理など）から、操作者を指定して照会する。
 * input は業務 DB の側で zod のスキーマで検証するので、外から来た値（job の内容）もそのまま渡せる。
 */
export async function queryAs<N extends QueryName>(
  env: Env,
  actorRef: ActorRef,
  name: N,
  input: QueryInput<N> | Readonly<Record<string, unknown>>,
): Promise<Result<QueryOutput<N>>> {
  const result = (await businessDb(env).query(name, input, actorRef)) as Result<unknown>;
  // runCommand と同じ理由で、registry の型に戻す
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return result as Result<QueryOutput<N>>;
}

export class QueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
