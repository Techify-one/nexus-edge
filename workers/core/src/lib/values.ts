import type { DatabasePort, SqlValue } from "@app/database";

export const dbTime = (
  db: DatabasePort,
  value: number | Date = Date.now(),
): SqlValue =>
  db.provider === "d1"
    ? value instanceof Date
      ? value.getTime()
      : value
    : value instanceof Date
      ? value
      : new Date(value);

export const numberTime = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  return Number(value);
};

export const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
};
