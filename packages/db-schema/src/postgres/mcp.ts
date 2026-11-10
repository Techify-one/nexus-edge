import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const epoch = (name: string) => bigint(name, { mode: "number" });
export const pluginMcpSettings = pgTable("plugin_mcp_settings", {
  pluginId: text("plugin_id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  allowedActionsJson: text("allowed_actions_json").notNull().default("[]"),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  updatedBy: text("updated_by").notNull(),
});
export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUrisJson: text("redirect_uris_json").notNull(),
  createdAt: epoch("created_at").notNull(),
});
export const mcpOauthCodes = pgTable("mcp_oauth_codes", {
  hash: text("hash").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  resource: text("resource").notNull(),
  challenge: text("challenge").notNull(),
  permissionsJson: text("permissions_json").notNull(),
  expiresAt: epoch("expires_at").notNull(),
  consumedAt: epoch("consumed_at"),
});
export const mcpOauthGrants = pgTable(
  "mcp_oauth_grants",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id").notNull(),
    resource: text("resource").notNull(),
    permissionsJson: text("permissions_json").notNull(),
    accessHash: text("access_hash").notNull().unique(),
    refreshHash: text("refresh_hash").notNull().unique(),
    accessExpiresAt: epoch("access_expires_at").notNull(),
    refreshExpiresAt: epoch("refresh_expires_at").notNull(),
    revokedAt: epoch("revoked_at"),
    createdAt: epoch("created_at").notNull(),
  },
  (table) => [index("mcp_oauth_grants_user_idx").on(table.userId)],
);
