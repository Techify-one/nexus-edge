import type { DatabasePort } from "@app/database";
import type {
  PluginContext,
  PluginInstallerContext,
  PluginPublicContext,
} from "@app/core-contract";

export type MeetingRecorderBindings = {
  DATABASE_PROVIDER: "d1" | "postgres";
  DB?: D1Database;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  STORAGE?: R2Bucket;
  AI?: Ai;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
};

export type MeetingRecorderVariables = {
  db: DatabasePort;
  pluginContext?: PluginContext;
  publicContext?: PluginPublicContext;
  installerContext?: PluginInstallerContext;
};

export type MeetingRecorderEnv = {
  Bindings: MeetingRecorderBindings;
  Variables: MeetingRecorderVariables;
};
