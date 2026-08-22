import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  active: boolean("active").notNull().default(true),
  createdAt: instant("created_at").notNull(),
  updatedAt: instant("updated_at").notNull(),
});
export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  phone: text("phone"),
  telegramId: text("telegram_id"),
  jobTitle: text("job_title"),
  birthDate: text("birth_date"),
  cpf: text("cpf"),
  tagsJson: text("tags_json").notNull().default("[]"),
  sectorsJson: text("sectors_json").notNull().default("[]"),
  notes: text("notes"),
  status: text("status").notNull().default("active"),
  createdAt: instant("created_at").notNull(),
  updatedAt: instant("updated_at").notNull(),
});
export const userWorkSchedules = pgTable(
  "user_work_schedules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    dailyHoursJson: text("daily_hours_json").notNull(),
    entryTimesJson: text("entry_times_json").notNull(),
    effectiveAt: instant("effective_at").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    index("user_work_schedules_user_effective_idx").on(
      t.userId,
      t.effectiveAt,
      t.createdAt,
    ),
  ],
);
export const userTablePreferences = pgTable(
  "user_table_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tableId: text("table_id").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    configJson: text("config_json").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tableId] })],
);
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: instant("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull().default("local:credential"),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: instant("access_token_expires_at"),
    refreshTokenExpiresAt: instant("refresh_token_expires_at"),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("account_issuer_id_unique").on(t.issuer, t.accountId),
    index("account_user_idx").on(t.userId),
  ],
);
export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: instant("expires_at").notNull(),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
export const rateLimit = pgTable("rateLimit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
export const apikey = pgTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull().default("default"),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    referenceId: text("reference_id").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: instant("last_refill_at"),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: instant("last_request"),
    expiresAt: instant("expires_at"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (t) => [
    index("apikey_reference_idx").on(t.referenceId),
    index("apikey_config_idx").on(t.configId),
  ],
);

export const appSettings = pgTable("app_settings", {
  id: text("id").primaryKey(),
  installationId: text("installation_id").notNull(),
  databaseProvider: text("database_provider").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  bootstrapState: text("bootstrap_state").notNull(),
  bootstrapEmail: text("bootstrap_email"),
  bootstrapClaimedAt: instant("bootstrap_claimed_at"),
  firstAdminUserId: text("first_admin_user_id"),
  bootstrapCompletedAt: instant("bootstrap_completed_at"),
});
export const userInvitations = pgTable(
  "user_invitations",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    groupIdsJson: jsonb("group_ids_json").notNull().default([]),
    expiresAt: instant("expires_at").notNull(),
    reservedAt: instant("reserved_at"),
    usedAt: instant("used_at"),
    revokedAt: instant("revoked_at"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [index("invitation_state_idx").on(t.email, t.usedAt, t.revokedAt)],
);
export const groups = pgTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: instant("created_at").notNull(),
  updatedAt: instant("updated_at").notNull(),
});
export const permissions = pgTable("permissions", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  createdAt: instant("created_at").notNull(),
});
export const groupMembers = pgTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("group_members_user_idx").on(t.userId),
  ],
);
export const groupPermissions = pgTable(
  "group_permissions",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    permissionId: text("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.permissionId] }),
    index("group_permissions_group_idx").on(t.groupId),
  ],
);
export const apiReauthTokens = pgTable(
  "api_reauth_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull(),
    authMethod: text("auth_method").notNull(),
    credentialId: text("credential_id"),
    expiresAt: instant("expires_at").notNull(),
    lastUsedAt: instant("last_used_at"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [index("reauth_user_expiry_idx").on(t.userId, t.expiresAt)],
);
export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    userId: text("user_id").notNull(),
    method: text("method").notNull(),
    routeKey: text("route_key").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body").notNull(),
    createdAt: instant("created_at").notNull(),
    expiresAt: instant("expires_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.userId, t.method, t.routeKey, t.idempotencyKeyHash],
    }),
    index("idempotency_expiry_idx").on(t.expiresAt),
  ],
);
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    userId: text("user_id"),
    authMethod: text("auth_method"),
    credentialId: text("credential_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    index("audit_created_idx").on(t.createdAt),
    index("audit_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const plugins = pgTable("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  installedVersion: text("installed_version"),
  apiVersion: integer("api_version").notNull(),
  databaseDialectsJson: jsonb("database_dialects_json").notNull(),
  activeDatabaseProvider: text("active_database_provider").notNull(),
  workerName: text("worker_name").notNull(),
  status: text("status").notNull(),
  manifestJson: jsonb("manifest_json").notNull(),
  installedAt: instant("installed_at"),
  updatedAt: instant("updated_at").notNull(),
});
export const pluginOperations = pgTable(
  "plugin_operations",
  {
    operationId: text("operation_id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    type: text("type").notNull(),
    targetVersion: text("target_version").notNull(),
    targetApiVersion: integer("target_api_version").notNull(),
    databaseProvider: text("database_provider").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    workerSha256: text("worker_sha256").notNull(),
    d1MigrationsSha256: text("d1_migrations_sha256").notNull(),
    postgresMigrationsSha256: text("postgres_migrations_sha256").notNull(),
    state: text("state").notNull(),
    lockAcquiredAt: instant("lock_acquired_at"),
    lockExpiresAt: instant("lock_expires_at"),
    lastError: text("last_error"),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: instant("created_at").notNull(),
    finishedAt: instant("finished_at"),
  },
  (t) => [
    index("plugin_operations_plugin_idx").on(t.pluginId, t.createdAt),
    index("plugin_operations_state_idx").on(t.state, t.lockExpiresAt),
  ],
);
export const pluginMigrations = pgTable(
  "plugin_migrations",
  {
    pluginId: text("plugin_id").notNull(),
    dialect: text("dialect").notNull(),
    migrationId: text("migration_id").notNull(),
    sha256: text("sha256").notNull(),
    appliedAt: instant("applied_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.dialect, t.migrationId] })],
);
export const pluginPackageChunks = pgTable(
  "plugin_package_chunks",
  {
    operationId: text("operation_id").notNull(),
    path: text("path").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.operationId, t.path, t.chunkIndex] })],
);
export const installerLock = pgTable("installer_lock", {
  id: text("id").primaryKey(),
  operationId: text("operation_id"),
  acquiredAt: instant("acquired_at"),
  expiresAt: instant("expires_at"),
});

export const coreEvents = pgTable(
  "core_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    resourceVersion: integer("resource_version").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    authMethod: text("auth_method").notNull(),
    requestId: text("request_id").notNull(),
    payloadText: text("payload_text").notNull(),
    occurredAt: instant("occurred_at").notNull(),
    status: text("status").notNull(),
    leaseExpiresAt: instant("lease_expires_at"),
    enqueuedAt: instant("enqueued_at"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    index("core_events_status_idx").on(t.status, t.leaseExpiresAt, t.createdAt),
  ],
);
export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  host: text("host").notNull(),
  urlCiphertext: text("url_ciphertext").notNull(),
  eventTypesJson: jsonb("event_types_json").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  keyId: text("key_id").notNull(),
  keyVersion: integer("key_version").notNull(),
  previousSecretCiphertext: text("previous_secret_ciphertext"),
  previousExpiresAt: instant("previous_expires_at"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: instant("created_at").notNull(),
  updatedAt: instant("updated_at").notNull(),
  disabledReason: text("disabled_reason"),
});
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id").notNull(),
    eventId: text("event_id").notNull(),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at"),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    responseBodySha256: text("response_body_sha256"),
    responseSize: integer("response_size"),
    deliveredAt: instant("delivered_at"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("webhook_delivery_unique").on(t.endpointId, t.eventId),
    index("webhook_delivery_status_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const crmLeads = pgTable(
  "crm_leads",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    company: text("company"),
    status: text("status").notNull(),
    notes: text("notes"),
    ownerUserId: text("owner_user_id").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    index("crm_leads_status_idx").on(t.status, t.updatedAt),
    index("crm_leads_owner_idx").on(t.ownerUserId, t.updatedAt),
  ],
);
export const crmActivities = pgTable(
  "crm_activities",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => crmLeads.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    body: text("body"),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [index("crm_activities_lead_idx").on(t.leadId, t.createdAt)],
);
