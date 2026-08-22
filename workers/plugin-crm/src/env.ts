import type { DatabasePort } from "@app/database";
import type { PluginContext } from "@app/core-contract";

export type CrmBindings = {
  DATABASE_PROVIDER: "d1" | "postgres";
  DB?: D1Database;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
};
export type CrmVariables = { db: DatabasePort; pluginContext: PluginContext };
export type CrmEnv = { Bindings: CrmBindings; Variables: CrmVariables };
