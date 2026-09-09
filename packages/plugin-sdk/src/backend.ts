import { Client } from "pg";

export type PluginContextV1 = {
  userId: string;
  permissions: string[];
  requestId: string;
  origin?: string;
};

export type PluginPublicContextV1 = {
  pluginId: string;
  requestId: string;
};

export type PluginInstallerContextV1 = {
  pluginId: string;
  operationId: string;
  requestId: string;
};

export type PluginDatabaseProvider = "d1" | "postgres";
export type PluginSqlValue =
  string | number | boolean | null | Uint8Array | Date;
export type PluginSqlStatement = {
  sql: string;
  params?: PluginSqlValue[];
};
export type PluginSqlMutationResult = { rowsAffected: number };

// Stable public aliases keep plugin source independent from Core-internal
// package names while making migrations from the legacy SDK mechanical.
export type PluginContext = PluginContextV1;
export type PluginPublicContext = PluginPublicContextV1;
export type PluginInstallerContext = PluginInstallerContextV1;
export type DatabasePort = PluginDatabase;
export type SqlValue = PluginSqlValue;
export type SqlStatement = PluginSqlStatement;

export const createId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export interface PluginDatabase {
  readonly provider: PluginDatabaseProvider;
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: PluginSqlValue[],
  ): Promise<T[]>;
  first<T extends Record<string, unknown>>(
    sql: string,
    params?: PluginSqlValue[],
  ): Promise<T | null>;
  execute(
    sql: string,
    params?: PluginSqlValue[],
  ): Promise<PluginSqlMutationResult>;
  atomic(statements: PluginSqlStatement[]): Promise<PluginSqlMutationResult[]>;
  close(): Promise<void>;
}

export type PluginDatabaseBindings = {
  DATABASE_PROVIDER: string;
  DB?: D1Database;
  HYPERDRIVE?: Hyperdrive;
};

const normalizeD1Value = (value: PluginSqlValue): unknown => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
};

class D1PluginDatabase implements PluginDatabase {
  readonly provider = "d1" as const;

  constructor(private readonly database: D1Database) {}

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: PluginSqlValue[] = [],
  ): Promise<T[]> {
    const result = await this.database
      .prepare(sql)
      .bind(...params.map(normalizeD1Value))
      .all<T>();
    return result.results ?? [];
  }

  async first<T extends Record<string, unknown>>(
    sql: string,
    params: PluginSqlValue[] = [],
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
    params: PluginSqlValue[] = [],
  ): Promise<PluginSqlMutationResult> {
    const result = await this.database
      .prepare(sql)
      .bind(...params.map(normalizeD1Value))
      .run();
    return { rowsAffected: result.meta.changes ?? 0 };
  }

  async atomic(
    statements: PluginSqlStatement[],
  ): Promise<PluginSqlMutationResult[]> {
    if (!statements.length) return [];
    const results = await this.database.batch(
      statements.map((statement) =>
        this.database
          .prepare(statement.sql)
          .bind(...(statement.params ?? []).map(normalizeD1Value)),
      ),
    );
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

class PostgresPluginDatabase implements PluginDatabase {
  readonly provider = "postgres" as const;

  constructor(private readonly client: Client) {}

  async query<T extends Record<string, unknown>>(
    sql: string,
    params: PluginSqlValue[] = [],
  ): Promise<T[]> {
    const result = await this.client.query(postgresSql(sql), params);
    return result.rows as T[];
  }

  async first<T extends Record<string, unknown>>(
    sql: string,
    params: PluginSqlValue[] = [],
  ): Promise<T | null> {
    return (await this.query<T>(`${sql} LIMIT 1`, params))[0] ?? null;
  }

  async execute(
    sql: string,
    params: PluginSqlValue[] = [],
  ): Promise<PluginSqlMutationResult> {
    const result = await this.client.query(postgresSql(sql), params);
    return { rowsAffected: result.rowCount ?? 0 };
  }

  async atomic(
    statements: PluginSqlStatement[],
  ): Promise<PluginSqlMutationResult[]> {
    await this.client.query("BEGIN");
    try {
      const results: PluginSqlMutationResult[] = [];
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

/** Open the installation database binding supplied to a plugin Worker. */
export async function createPluginDatabase(
  env: PluginDatabaseBindings,
): Promise<PluginDatabase> {
  if (env.DATABASE_PROVIDER === "d1") {
    if (!env.DB || env.HYPERDRIVE)
      throw new Error("D1 requires only the DB binding.");
    return new D1PluginDatabase(env.DB);
  }
  if (env.DATABASE_PROVIDER === "postgres") {
    if (!env.HYPERDRIVE || env.DB)
      throw new Error("PostgreSQL requires only the HYPERDRIVE binding.");
    const client = new Client({
      connectionString: env.HYPERDRIVE.connectionString,
    });
    await client.connect();
    return new PostgresPluginDatabase(client);
  }
  throw new Error("DATABASE_PROVIDER must be d1 or postgres.");
}

export const createDatabase = createPluginDatabase;
