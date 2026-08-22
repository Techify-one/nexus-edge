-- Replace broad Core permissions with independent CRUD permissions while
-- preserving every existing group assignment.

INSERT INTO permissions(id, key, created_at) VALUES
  ('perm_core_user_read', 'core.user.read', CURRENT_TIMESTAMP),
  ('perm_core_user_create', 'core.user.create', CURRENT_TIMESTAMP),
  ('perm_core_user_update', 'core.user.update', CURRENT_TIMESTAMP),
  ('perm_core_user_delete', 'core.user.delete', CURRENT_TIMESTAMP),
  ('perm_core_group_read', 'core.group.read', CURRENT_TIMESTAMP),
  ('perm_core_group_create', 'core.group.create', CURRENT_TIMESTAMP),
  ('perm_core_group_update', 'core.group.update', CURRENT_TIMESTAMP),
  ('perm_core_group_delete', 'core.group.delete', CURRENT_TIMESTAMP),
  ('perm_core_plugin_read', 'core.plugin.read', CURRENT_TIMESTAMP),
  ('perm_core_plugin_create', 'core.plugin.create', CURRENT_TIMESTAMP),
  ('perm_core_plugin_update', 'core.plugin.update', CURRENT_TIMESTAMP),
  ('perm_core_plugin_delete', 'core.plugin.delete', CURRENT_TIMESTAMP),
  ('perm_core_webhook_read', 'core.webhook.read', CURRENT_TIMESTAMP),
  ('perm_core_webhook_create', 'core.webhook.create', CURRENT_TIMESTAMP),
  ('perm_core_webhook_update', 'core.webhook.update', CURRENT_TIMESTAMP),
  ('perm_core_webhook_delete', 'core.webhook.delete', CURRENT_TIMESTAMP),
  ('perm_core_webhook_test', 'core.webhook.test', CURRENT_TIMESTAMP),
  ('perm_core_webhook_redeliver', 'core.webhook.redeliver', CURRENT_TIMESTAMP),
  ('perm_core_audit_read', 'core.audit.read', CURRENT_TIMESTAMP)
ON CONFLICT (key) DO NOTHING;

INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.user.invite'
JOIN permissions target ON target.key = 'core.user.create' ON CONFLICT DO NOTHING;
INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.user.manage'
JOIN permissions target ON target.key = 'core.user.update' ON CONFLICT DO NOTHING;
INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.user.manage'
JOIN permissions target ON target.key = 'core.user.delete' ON CONFLICT DO NOTHING;

INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.group.manage'
JOIN permissions target ON target.key = 'core.group.create' ON CONFLICT DO NOTHING;
INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.group.manage'
JOIN permissions target ON target.key = 'core.group.update' ON CONFLICT DO NOTHING;
INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.group.manage'
JOIN permissions target ON target.key = 'core.group.delete' ON CONFLICT DO NOTHING;

INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.plugin.install'
JOIN permissions target ON target.key = 'core.plugin.create' ON CONFLICT DO NOTHING;
INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.plugin.install'
JOIN permissions target ON target.key = 'core.plugin.update' ON CONFLICT DO NOTHING;
INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.plugin.uninstall'
JOIN permissions target ON target.key = 'core.plugin.delete' ON CONFLICT DO NOTHING;

INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.webhook.manage'
JOIN permissions target ON target.key = 'core.webhook.create' ON CONFLICT DO NOTHING;
INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.webhook.manage'
JOIN permissions target ON target.key = 'core.webhook.update' ON CONFLICT DO NOTHING;
INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.webhook.manage'
JOIN permissions target ON target.key = 'core.webhook.delete' ON CONFLICT DO NOTHING;
INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT gp.group_id, target.id, gp.created_at FROM group_permissions gp
JOIN permissions legacy ON legacy.id = gp.permission_id AND legacy.key = 'core.webhook.rotate'
JOIN permissions target ON target.key = 'core.webhook.update' ON CONFLICT DO NOTHING;

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
