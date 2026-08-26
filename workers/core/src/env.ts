import type { DatabasePort } from "@app/database";
import type { MongoAbility } from "@casl/ability";
import type { RequestPrincipal } from "@app/core-contract";

export type CoreEnv = {
  APP_VERSION: string;
  CORE_UPDATE_PUBLIC_KEY: string;
  APP_INSTALLATION_ID: string;
  DATABASE_PROVIDER: "d1" | "postgres";
  DB?: D1Database;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  BETTER_AUTH_URL: string;
  TRUSTED_ORIGINS: string;
  BETTER_AUTH_SECRET: string;
  WEBHOOK_ENCRYPTION_KEY: string;
  WEBHOOK_ALLOWED_DOMAINS?: string;
  API_RATE_LIMIT_MAX?: string;
  API_RATE_LIMIT_WINDOW_SECONDS?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CORE_WORKER_NAME: string;
  D1_DATABASE_ID?: string;
  HYPERDRIVE_ID?: string;
  PLUGIN_COMPATIBILITY_FLAGS?: string;
  WEBHOOK_QUEUE: Queue<WebhookQueueMessage>;
  ASSETS?: Fetcher;
  PLUGIN_CRM?: Fetcher;
  [binding: `PLUGIN_${string}`]: unknown;
};

export type WebhookQueueMessage =
  | { kind: "fanout"; eventId: string }
  | { kind: "delivery"; deliveryId: string };

export type AppAbility = MongoAbility<[string, string]>;

export type Variables = {
  requestId: string;
  db: DatabasePort;
  auth: ReturnType<typeof import("./auth/factory.js").createAuth>;
  principal: RequestPrincipal;
  ability: AppAbility;
};

export type HonoEnv = { Bindings: CoreEnv; Variables: Variables };
