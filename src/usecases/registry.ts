/**
 * ユースケースの一覧。web 層からは名前で呼び出す。
 * 機能を追加するときは、usecases/<区分>/index.ts の一覧に1行ずつ追加する。
 */
import type { z } from "zod";

import { billingCommands, billingQueries } from "./billing";
import type { CommandDef, QueryDef } from "./core";
import { mastersCommands, mastersQueries } from "./masters";
import { platformCommands, platformQueries } from "./platform";
import { purchasingCommands, purchasingQueries } from "./purchasing";
import { salesCommands, salesQueries } from "./sales";
import { stockCommands, stockQueries } from "./stock";

export const commands = {
  ...mastersCommands,
  ...stockCommands,
  ...purchasingCommands,
  ...salesCommands,
  ...billingCommands,
  ...platformCommands,
};

export const queries = {
  ...mastersQueries,
  ...stockQueries,
  ...purchasingQueries,
  ...salesQueries,
  ...billingQueries,
  ...platformQueries,
};

type Commands = typeof commands;
type Queries = typeof queries;

export type CommandName = keyof Commands;
export type QueryName = keyof Queries;

export type CommandInput<N extends CommandName> =
  Commands[N] extends CommandDef<infer S, unknown> ? z.input<S> : never;
export type CommandOutput<N extends CommandName> =
  Commands[N] extends CommandDef<z.ZodType, infer O> ? O : never;
export type QueryInput<N extends QueryName> =
  Queries[N] extends QueryDef<infer S, unknown> ? z.input<S> : never;
export type QueryOutput<N extends QueryName> =
  Queries[N] extends QueryDef<z.ZodType, infer O> ? O : never;
