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

export type ProfileOption = { value: string; usageCount: number };

export const countProfileOptions = (
  serializedValues: unknown[],
): ProfileOption[] => {
  const counts = new Map<string, ProfileOption>();
  for (const serialized of serializedValues) {
    const values = parseJson<unknown>(serialized, []);
    if (!Array.isArray(values)) continue;
    const seen = new Set<string>();
    for (const item of values) {
      if (typeof item !== "string") continue;
      const value = item.trim();
      if (!value) continue;
      const key = value.toLocaleLowerCase("pt-BR");
      if (seen.has(key)) continue;
      seen.add(key);
      const current = counts.get(key);
      if (current) current.usageCount += 1;
      else counts.set(key, { value, usageCount: 1 });
    }
  }
  return [...counts.values()].sort(
    (left, right) =>
      right.usageCount - left.usageCount ||
      left.value.localeCompare(right.value, "pt-BR", { sensitivity: "base" }),
  );
};
