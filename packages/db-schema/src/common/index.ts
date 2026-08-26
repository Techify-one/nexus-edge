export const SCHEMA_VERSION = 1;
export const SYSTEM_SETTINGS_ID = "system";
export const INSTALLER_LOCK_ID = "global";

export const CORE_PERMISSIONS = [
  "core.user.read",
  "core.user.create",
  "core.user.update",
  "core.user.delete",
  "core.group.read",
  "core.group.create",
  "core.group.update",
  "core.group.delete",
  "core.plugin.read",
  "core.plugin.create",
  "core.plugin.update",
  "core.plugin.delete",
  "core.plugin.export",
  "core.webhook.read",
  "core.webhook.create",
  "core.webhook.update",
  "core.webhook.delete",
  "core.webhook.test",
  "core.webhook.redeliver",
  "core.audit.read",
  "core.settings.read",
  "core.settings.update",
] as const;

export type BootstrapState = "open" | "claimed" | "complete";
export type DatabaseProvider = "d1" | "postgres";
