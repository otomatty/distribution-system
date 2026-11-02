export type Query = Record<string, string | number | boolean | null | undefined>;

/** クエリ文字列つきの URL。空の値は付けない */
export function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export const enc = encodeURIComponent;
