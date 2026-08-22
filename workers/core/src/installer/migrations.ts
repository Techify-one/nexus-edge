import type { SqlStatement } from "@app/database";

export type MigrationSet = Record<string, string>;

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (!quote && char === "-" && next === "-") {
      lineComment = true;
      index++;
      continue;
    }
    if (!quote && char === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote && next === quote) {
        current += next;
        index++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quote || blockComment)
    throw new Error("Unterminated SQL literal or comment");
  if (current.trim()) statements.push(current.trim());
  return statements;
}

const tokens = (statement: string): string[] =>
  statement
    .replaceAll(/[(),]/gu, " ")
    .split(/\s+/u)
    .map((token) => token.replaceAll(/["`]/gu, ""))
    .filter(Boolean);

export function validateAdditiveMigration(
  statement: string,
  prefix: string,
): void {
  const words = tokens(statement);
  const upper = words.map((word) => word.toUpperCase());
  const forbidden = new Set([
    "DROP",
    "DELETE",
    "UPDATE",
    "INSERT",
    "REPLACE",
    "TRUNCATE",
    "PRAGMA",
    "ATTACH",
    "DETACH",
    "VACUUM",
    "REINDEX",
  ]);
  if (upper.some((word) => forbidden.has(word)))
    throw new Error("Migration contains a forbidden statement");
  let tableName: string | undefined;
  if (upper[0] === "CREATE" && upper[1] === "TABLE") {
    const offset = upper[2] === "IF" ? 5 : 2;
    tableName = words[offset];
  } else if (
    upper[0] === "CREATE" &&
    (upper[1] === "INDEX" || upper[1] === "UNIQUE")
  ) {
    const onIndex = upper.indexOf("ON");
    tableName = onIndex >= 0 ? words[onIndex + 1] : undefined;
  } else if (
    upper[0] === "ALTER" &&
    upper[1] === "TABLE" &&
    upper.includes("ADD") &&
    upper.includes("COLUMN")
  ) {
    tableName = words[2];
  } else {
    throw new Error(
      "Only CREATE TABLE, CREATE INDEX and ALTER TABLE ADD COLUMN are permitted",
    );
  }
  if (!tableName?.startsWith(prefix))
    throw new Error(`Migration table must start with ${prefix}`);
}

export function migrationStatements(
  set: MigrationSet,
  prefix: string,
): Array<{ migrationId: string; statements: SqlStatement[] }> {
  return Object.entries(set)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([migrationId, sql]) => {
      if (!/^\d{4}_[a-z0-9_]+$/u.test(migrationId))
        throw new Error(`Invalid migration id: ${migrationId}`);
      const statements = splitSqlStatements(sql);
      if (!statements.length)
        throw new Error(`Empty migration: ${migrationId}`);
      for (const statement of statements)
        validateAdditiveMigration(statement, prefix);
      return {
        migrationId,
        statements: statements.map((statement) => ({ sql: statement })),
      };
    });
}
