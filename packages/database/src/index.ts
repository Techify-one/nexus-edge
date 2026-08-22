import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as d1Schema from "@app/db-schema/d1";
import * as postgresSchema from "@app/db-schema/postgres";

export type DatabaseProvider = "d1" | "postgres";
export type SqlValue = string | number | boolean | null | Uint8Array | Date;
export type SqlStatement = { sql: string; params?: SqlValue[] };

export type SqlMutationResult = {
  rowsAffected: number;
};

export interface DatabasePort {
  readonly provider: DatabaseProvider;
  readonly orm: unknown;
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: SqlValue[],
  ): Promise<T[]>;
  first<T extends Record<string, unknown>>(
    sql: string,
    params?: SqlValue[],
  ): Promise<T | null>;
  execute(sql: string, params?: SqlValue[]): Promise<SqlMutationResult>;
  atomic(statements: SqlStatement[]): Promise<SqlMutationResult[]>;
  close(): Promise<void>;
}

export type DatabaseBindings = {
  DATABASE_PROVIDER: string;
  DB?: D1Database;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
};

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

const normalizeD1Value = (value: SqlValue): unknown => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
};

class D1DatabaseAdapter implements DatabasePort {
  readonly provider = "d1" as const;
  readonly orm;

  constructor(private readonly database: D1Database) {
    this.orm = drizzleD1(database, { schema: d1Schema });
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<T[]> {
    const result = await this.database
      .prepare(sql)
      .bind(...params.map(normalizeD1Value))
      .all<T>();
    return result.results ?? [];
  }

  async first<T extends Record<string, unknown>>(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<T | null> {
    return (
      (await this.database
        .prepare(sql)
        .bind(...params.map(normalizeD1Value))
        .first<T>()) ?? null
    );
  }

  async execute(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<SqlMutationResult> {
    const result = await this.database
      .prepare(sql)
      .bind(...params.map(normalizeD1Value))
      .run();
    return { rowsAffected: result.meta.changes ?? 0 };
  }

  async atomic(statements: SqlStatement[]): Promise<SqlMutationResult[]> {
    if (statements.length === 0) return [];
    const prepared = statements.map((statement) =>
      this.database
        .prepare(statement.sql)
        .bind(...(statement.params ?? []).map(normalizeD1Value)),
    );
    const results = await this.database.batch(prepared);
    return results.map((result) => ({
      rowsAffected: result.meta.changes ?? 0,
    }));
  }

  async close(): Promise<void> {}
}

const postgresSql = (sql: string): string => {
  let index = 0;
  return sql.replaceAll("?", () => `$${++index}`);
};

const normalizePostgresValue = (value: SqlValue): unknown => {
  return value;
};

class PostgresDatabaseAdapter implements DatabasePort {
  readonly provider = "postgres" as const;
  readonly orm;

  constructor(private readonly client: Client) {
    this.orm = drizzlePostgres(client, { schema: postgresSchema });
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<T[]> {
    const result = await this.client.query(
      postgresSql(sql),
      params.map(normalizePostgresValue),
    );
    return result.rows as T[];
  }

  async first<T extends Record<string, unknown>>(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<T | null> {
    return (await this.query<T>(`${sql} LIMIT 1`, params))[0] ?? null;
  }

  async execute(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<SqlMutationResult> {
    const result = await this.client.query(
      postgresSql(sql),
      params.map(normalizePostgresValue),
    );
    return { rowsAffected: result.rowCount ?? 0 };
  }

  async atomic(statements: SqlStatement[]): Promise<SqlMutationResult[]> {
    await this.client.query("BEGIN");
    try {
      const results: SqlMutationResult[] = [];
      for (const statement of statements)
        results.push(await this.execute(statement.sql, statement.params));
      await this.client.query("COMMIT");
      return results;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export function validateDatabaseBindings(
  env: DatabaseBindings,
): DatabaseProvider {
  if (env.DATABASE_PROVIDER !== "d1" && env.DATABASE_PROVIDER !== "postgres") {
    throw new DatabaseConfigurationError(
      "DATABASE_PROVIDER must be exactly d1 or postgres",
    );
  }
  if (env.DATABASE_PROVIDER === "d1") {
    if (!env.DB)
      throw new DatabaseConfigurationError(
        "D1 provider requires the DB binding",
      );
    if (env.HYPERDRIVE)
      throw new DatabaseConfigurationError(
        "D1 provider cannot have a HYPERDRIVE binding",
      );
    return "d1";
  }
  if (!env.HYPERDRIVE && !env.DATABASE_URL) {
    throw new DatabaseConfigurationError(
      "PostgreSQL provider requires HYPERDRIVE in production",
    );
  }
  if (env.DB)
    throw new DatabaseConfigurationError(
      "PostgreSQL provider cannot have a DB binding",
    );
  return "postgres";
}

export async function createDatabase(
  env: DatabaseBindings,
): Promise<DatabasePort> {
  const provider = validateDatabaseBindings(env);
  if (provider === "d1") return new D1DatabaseAdapter(env.DB!);

  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  const client = new Client({ connectionString });
  await client.connect();
  return new PostgresDatabaseAdapter(client);
}

export async function withDatabase<T>(
  env: DatabaseBindings,
  callback: (db: DatabasePort) => Promise<T>,
): Promise<T> {
  const database = await createDatabase(env);
  try {
    return await callback(database);
  } finally {
    await database.close();
  }
}

export const encodeCursor = (parts: unknown[]): string =>
  btoa(JSON.stringify(parts))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

export const decodeCursor = (cursor: string | undefined): unknown[] | null => {
  if (!cursor) return null;
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(normalized)) as unknown[];
  } catch {
    return null;
  }
};
