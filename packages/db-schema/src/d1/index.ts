import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const instant = (name: string) => integer(name, { mode: "timestamp_ms" });

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: instant("created_at").notNull(),
  updatedAt: instant("updated_at").notNull(),
});
export const userProfiles = sqliteTable("user_profiles", {
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
export const userWorkSchedules = sqliteTable(
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
export const userTablePreferences = sqliteTable(
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
export const userOverviewPreferences = sqliteTable(
  "user_overview_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    configJson: text("config_json").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
);
export const session = sqliteTable(
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
export const account = sqliteTable(
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
export const verification = sqliteTable(
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
export const rateLimit = sqliteTable("rateLimit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});
export const apikey = sqliteTable(
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
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    rateLimitEnabled: integer("rate_limit_enabled", {
      mode: "boolean",
    }).default(true),
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

export const appSettings = sqliteTable("app_settings", {
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
export const userInvitations = sqliteTable(
  "user_invitations",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    groupIdsJson: text("group_ids_json").notNull().default("[]"),
    expiresAt: instant("expires_at").notNull(),
    reservedAt: instant("reserved_at"),
    usedAt: instant("used_at"),
    revokedAt: instant("revoked_at"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [index("invitation_state_idx").on(t.email, t.usedAt, t.revokedAt)],
);
export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  createdAt: instant("created_at").notNull(),
  updatedAt: instant("updated_at").notNull(),
});
export const permissions = sqliteTable("permissions", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  createdAt: instant("created_at").notNull(),
});
export const groupMembers = sqliteTable(
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
export const groupPermissions = sqliteTable(
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

export const apiReauthTokens = sqliteTable(
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
export const apiIdempotencyKeys = sqliteTable(
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
export const auditLog = sqliteTable(
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
    metadataJson: text("metadata_json").notNull().default("{}"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    index("audit_created_idx").on(t.createdAt),
    index("audit_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  installedVersion: text("installed_version"),
  apiVersion: integer("api_version").notNull(),
  databaseDialectsJson: text("database_dialects_json").notNull(),
  activeDatabaseProvider: text("active_database_provider").notNull(),
  workerName: text("worker_name").notNull(),
  status: text("status").notNull(),
  manifestJson: text("manifest_json").notNull(),
  packageFormat: integer("package_format").notNull().default(1),
  marketplaceId: text("marketplace_id"),
  publisherId: text("publisher_id"),
  releaseId: text("release_id"),
  releaseHash: text("release_hash"),
  installedAt: instant("installed_at"),
  updatedAt: instant("updated_at").notNull(),
});
export const pluginOperations = sqliteTable(
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
    sourceReleaseId: text("source_release_id"),
    packageFormat: integer("package_format").notNull().default(1),
    assetsSha256: text("assets_sha256"),
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
export const pluginMigrations = sqliteTable(
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
export const pluginPackageChunks = sqliteTable(
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
export const pluginRuntimeResources = sqliteTable(
  "plugin_runtime_resources",
  {
    pluginId: text("plugin_id").notNull(),
    resourceType: text("resource_type").notNull(),
    bindingName: text("binding_name").notNull(),
    externalName: text("external_name").notNull().unique(),
    status: text("status").notNull(),
    createdByOperationId: text("created_by_operation_id").notNull(),
    lastVerifiedAt: instant("last_verified_at"),
    lastErrorCode: text("last_error_code"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
    preservedAt: instant("preserved_at"),
  },
  (t) => [
    primaryKey({ columns: [t.pluginId, t.bindingName] }),
    index("plugin_runtime_resources_status_idx").on(t.status, t.updatedAt),
  ],
);
export const pluginMarketplaces = sqliteTable(
  "plugin_marketplaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    owner: text("owner").notNull(),
    repository: text("repository").notNull(),
    repositoryId: text("repository_id"),
    sourceRef: text("source_ref").notNull().default("main"),
    catalogPath: text("catalog_path")
      .notNull()
      .default("nexus-marketplace.json"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    trustState: text("trust_state").notNull().default("pending"),
    trustedPublicKey: text("trusted_public_key"),
    keyFingerprint: text("key_fingerprint"),
    etag: text("etag"),
    catalogJson: text("catalog_json"),
    catalogExpiresAt: instant("catalog_expires_at"),
    retryAfterAt: instant("retry_after_at"),
    credentialRef: text("credential_ref"),
    lastSyncedAt: instant("last_synced_at"),
    lastErrorCode: text("last_error_code"),
    removedAt: instant("removed_at"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("plugin_marketplaces_source_idx").on(
      t.owner,
      t.repository,
      t.sourceRef,
      t.catalogPath,
    ),
  ],
);
export const pluginMarketplaceKeys = sqliteTable(
  "plugin_marketplace_keys",
  {
    marketplaceId: text("marketplace_id").notNull(),
    keyId: text("key_id").notNull(),
    publisherId: text("publisher_id").notNull(),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull(),
    validFrom: instant("valid_from").notNull(),
    validUntil: instant("valid_until"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.marketplaceId, t.keyId] })],
);
export const pluginCatalogSnapshots = sqliteTable(
  "plugin_catalog_snapshots",
  {
    id: text("id").primaryKey(),
    marketplaceId: text("marketplace_id").notNull(),
    revision: text("revision").notNull(),
    sha256: text("sha256").notNull(),
    etag: text("etag"),
    catalogJson: text("catalog_json").notNull(),
    fetchedAt: instant("fetched_at").notNull(),
  },
  (t) => [
    uniqueIndex("plugin_catalog_snapshots_revision_idx").on(
      t.marketplaceId,
      t.revision,
    ),
  ],
);
export const pluginReleases = sqliteTable(
  "plugin_releases",
  {
    id: text("id").primaryKey(),
    marketplaceId: text("marketplace_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    publisherId: text("publisher_id").notNull(),
    publisherName: text("publisher_name").notNull(),
    version: text("version").notNull(),
    channel: text("channel").notNull().default("stable"),
    description: text("description").notNull().default(""),
    manifestJson: text("manifest_json").notNull(),
    artifactUrl: text("artifact_url").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    artifactSignature: text("artifact_signature").notNull(),
    packageBytes: integer("package_bytes"),
    compatible: integer("compatible", { mode: "boolean" })
      .notNull()
      .default(true),
    compatibilityReason: text("compatibility_reason"),
    publishedAt: instant("published_at"),
    discoveredAt: instant("discovered_at").notNull(),
  },
  (t) => [
    uniqueIndex("plugin_releases_version_idx").on(
      t.marketplaceId,
      t.pluginId,
      t.channel,
      t.version,
    ),
    index("plugin_releases_catalog_idx").on(
      t.pluginId,
      t.channel,
      t.discoveredAt,
    ),
  ],
);
export const pluginAssets = sqliteTable(
  "plugin_assets",
  {
    pluginId: text("plugin_id").notNull(),
    releaseHash: text("release_hash").notNull(),
    path: text("path").notNull(),
    contentType: text("content_type").notNull(),
    operationId: text("operation_id").notNull(),
    sha256: text("sha256").notNull(),
    byteLength: integer("byte_length").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(false),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pluginId, t.releaseHash, t.path] }),
    index("plugin_assets_active_idx").on(t.pluginId, t.active, t.path),
    index("plugin_assets_operation_idx").on(t.operationId, t.path),
  ],
);
export const pluginContributions = sqliteTable(
  "plugin_contributions",
  {
    pluginId: text("plugin_id").notNull(),
    releaseHash: text("release_hash").notNull(),
    kind: text("kind").notNull(),
    contributionId: text("contribution_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(false),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.pluginId, t.releaseHash, t.kind, t.contributionId],
    }),
  ],
);
export const pluginResourcesV2 = sqliteTable(
  "plugin_resources_v2",
  {
    pluginId: text("plugin_id").notNull(),
    logicalName: text("logical_name").notNull(),
    resourceType: text("resource_type").notNull(),
    capabilityVersion: integer("capability_version").notNull().default(1),
    bindingName: text("binding_name").notNull(),
    externalId: text("external_id"),
    externalName: text("external_name"),
    ownerWorkerName: text("owner_worker_name"),
    required: integer("required", { mode: "boolean" }).notNull().default(true),
    status: text("status").notNull(),
    retentionPolicy: text("retention_policy").notNull().default("preserve"),
    declarationJson: text("declaration_json").notNull(),
    lastErrorCode: text("last_error_code"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
    preservedAt: instant("preserved_at"),
  },
  (t) => [
    primaryKey({ columns: [t.pluginId, t.logicalName] }),
    uniqueIndex("plugin_resources_v2_binding_idx").on(
      t.pluginId,
      t.bindingName,
    ),
  ],
);
export const pluginDependencyLocks = sqliteTable(
  "plugin_dependency_locks",
  {
    pluginId: text("plugin_id").notNull(),
    dependencyPluginId: text("dependency_plugin_id").notNull(),
    version: text("version").notNull(),
    marketplaceId: text("marketplace_id"),
    releaseId: text("release_id"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.dependencyPluginId] })],
);
export const installerLock = sqliteTable("installer_lock", {
  id: text("id").primaryKey(),
  operationId: text("operation_id"),
  acquiredAt: instant("acquired_at"),
  expiresAt: instant("expires_at"),
});

export const coreUpdateOperations = sqliteTable(
  "core_update_operations",
  {
    operationId: text("operation_id").primaryKey(),
    releaseId: text("release_id").notNull(),
    targetVersion: text("target_version").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    state: text("state").notNull(),
    restoreTimestamp: instant("restore_timestamp"),
    lastError: text("last_error"),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
    completedAt: instant("completed_at"),
  },
  (t) => [index("core_update_operations_state_idx").on(t.state, t.updatedAt)],
);

export const coreEvents = sqliteTable(
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
export const webhookEndpoints = sqliteTable("webhook_endpoints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  host: text("host").notNull(),
  urlCiphertext: text("url_ciphertext").notNull(),
  eventTypesJson: text("event_types_json").notNull(),
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
export const webhookDeliveries = sqliteTable(
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
