/** 構造化ログ。Workers のログに JSON で出力する。 */
type Level = "info" | "warn" | "error";

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...fields, at: new Date().toISOString() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function errorFields(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { error: error.message, stack: error.stack }
    : { error: String(error) };
}
