-- Replace broad Core permissions with independent CRUD permissions while
-- preserving every existing group assignment.

INSERT OR IGNORE INTO permissions(id, key, created_at) VALUES
  ('perm_core_user_read', 'core.user.read', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_user_create', 'core.user.create', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_user_update', 'core.user.update', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_user_delete', 'core.user.delete', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_group_read', 'core.group.read', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_group_create', 'core.group.create', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_group_update', 'core.group.update', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_group_delete', 'core.group.delete', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_plugin_read', 'core.plugin.read', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_plugin_create', 'core.plugin.create', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_plugin_update', 'core.plugin.update', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_plugin_delete', 'core.plugin.delete', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_webhook_read', 'core.webhook.read', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_webhook_create', 'core.webhook.create', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_webhook_update', 'core.webhook.update', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_webhook_delete', 'core.webhook.delete', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_webhook_test', 'core.webhook.test', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_webhook_redeliver', 'core.webhook.redeliver', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_audit_read', 'core.audit.read', CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.user.invite'
JOIN permissions target ON target.key = 'core.user.create';
INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.user.manage'
JOIN permissions target ON target.key = 'core.user.update';
INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.user.manage'
JOIN permissions target ON target.key = 'core.user.delete';

INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.group.manage'
JOIN permissions target ON target.key = 'core.group.create';
INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.group.manage'
JOIN permissions target ON target.key = 'core.group.update';
INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.group.manage'
JOIN permissions target ON target.key = 'core.group.delete';

INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.plugin.install'
JOIN permissions target ON target.key = 'core.plugin.create';
INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.plugin.install'
JOIN permissions target ON target.key = 'core.plugin.update';
INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.plugin.uninstall'
JOIN permissions target ON target.key = 'core.plugin.delete';

INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.webhook.manage'
JOIN permissions target ON target.key = 'core.webhook.create';
INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.webhook.manage'
JOIN permissions target ON target.key = 'core.webhook.update';
INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.webhook.manage'
JOIN permissions target ON target.key = 'core.webhook.delete';
INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.webhook.rotate'
JOIN permissions target ON target.key = 'core.webhook.update';

DELETE FROM group_permissions
WHERE permission_id IN (
  SELECT id FROM permissions WHERE key IN (
    'core.user.invite', 'core.user.manage', 'core.group.manage',
    'core.plugin.install', 'core.plugin.uninstall',
    'core.webhook.manage', 'core.webhook.rotate'
  )
);
DELETE FROM permissions WHERE key IN (
  'core.user.invite', 'core.user.manage', 'core.group.manage',
  'core.plugin.install', 'core.plugin.uninstall',
  'core.webhook.manage', 'core.webhook.rotate'
);
