import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pluginMcpSettings = sqliteTable("plugin_mcp_settings", {
  pluginId: text("plugin_id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  allowedActionsJson: text("allowed_actions_json").notNull().default("[]"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  updatedBy: text("updated_by").notNull(),
});
export const mcpOauthClients = sqliteTable("mcp_oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUrisJson: text("redirect_uris_json").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const mcpOauthCodes = sqliteTable("mcp_oauth_codes", {
  hash: text("hash").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  resource: text("resource").notNull(),
  challenge: text("challenge").notNull(),
  permissionsJson: text("permissions_json").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
});
export const mcpOauthGrants = sqliteTable(
  "mcp_oauth_grants",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id").notNull(),
    resource: text("resource").notNull(),
    permissionsJson: text("permissions_json").notNull(),
    accessHash: text("access_hash").notNull().unique(),
    refreshHash: text("refresh_hash").notNull().unique(),
    accessExpiresAt: integer("access_expires_at").notNull(),
    refreshExpiresAt: integer("refresh_expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("mcp_oauth_grants_user_idx").on(table.userId)],
);
