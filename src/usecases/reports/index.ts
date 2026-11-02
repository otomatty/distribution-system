/** 集計（売上・仕入の月別の集計）のユースケース。追加したら下の一覧に1行ずつ登録する */
import { monthlyReport, reportCells } from "./monthly";

export const reportsCommands = {} as const;

export const reportsQueries = {
  "reports.monthly": monthlyReport,
  "reports.cells": reportCells,
} as const;
