import { enc, withQuery, type Query } from "./query";

/** 帳票・処理状況など共通の仕組みの画面 */
export const platformPaths = {
  jobs: () => "/jobs",
  job: (id: string) => `/jobs/${enc(id)}`,
  jobDownload: (id: string) => `/jobs/${enc(id)}/download`,
  documents: (query?: Query) => withQuery("/documents", query),
};
