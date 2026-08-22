import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

let database: DatabaseSync | undefined;
afterEach(() => database?.close());

describe("Core permission migration", () => {
  it("preserves custom group access while replacing every broad permission", () => {
    database = new DatabaseSync(":memory:");
    database.exec(
      readFileSync("workers/core/migrations/d1/0001_init.sql", "utf8"),
    );
    database.exec(`
      INSERT INTO groups(id,name,is_admin,created_at,updated_at)
      VALUES ('grp_custom','Custom',0,1,1);
      INSERT INTO permissions(id,key,created_at) VALUES
        ('legacy_user_invite','core.user.invite',1),
        ('legacy_user_manage','core.user.manage',1),
        ('legacy_group_manage','core.group.manage',1),
        ('legacy_plugin_install','core.plugin.install',1),
        ('legacy_plugin_uninstall','core.plugin.uninstall',1),
        ('legacy_webhook_manage','core.webhook.manage',1),
        ('legacy_webhook_rotate','core.webhook.rotate',1);
      INSERT INTO group_permissions(group_id,permission_id,created_at)
      SELECT 'grp_custom',id,1 FROM permissions WHERE key LIKE 'core.%';
    `);
    const migration = readFileSync(
      "workers/core/migrations/d1/0002_granular_permissions.sql",
      "utf8",
    );
    database.exec(migration);
    database.exec(migration);

    const keys = database
      .prepare(
        `SELECT p.key FROM group_permissions gp
         JOIN permissions p ON p.id = gp.permission_id
         WHERE gp.group_id = 'grp_custom' ORDER BY p.key`,
      )
      .all()
      .map((row) => String(row.key));
    expect(keys).toEqual([
      "core.group.create",
      "core.group.delete",
      "core.group.update",
      "core.plugin.create",
      "core.plugin.delete",
      "core.plugin.update",
      "core.user.create",
      "core.user.delete",
      "core.user.update",
      "core.webhook.create",
      "core.webhook.delete",
      "core.webhook.update",
    ]);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM permissions
           WHERE key IN (
             'core.user.invite','core.user.manage','core.group.manage',
             'core.plugin.install','core.plugin.uninstall',
             'core.webhook.manage','core.webhook.rotate'
           )`,
        )
        .get()?.count,
    ).toBe(0);
  });

  it("grants plugin package export only to administrator groups", () => {
    database = new DatabaseSync(":memory:");
    database.exec(
      readFileSync("workers/core/migrations/d1/0001_init.sql", "utf8"),
    );
    database.exec(`
      INSERT INTO groups(id,name,is_admin,created_at,updated_at) VALUES
        ('grp_admin','Admin',1,1,1),
        ('grp_custom','Custom',0,1,1);
    `);
    const migration = readFileSync(
      "workers/core/migrations/d1/0005_plugin_package_exports.sql",
      "utf8",
    );
    database.exec(migration);
    database.exec(migration);

    expect(
      database
        .prepare(
          `SELECT g.id FROM group_permissions gp
           JOIN groups g ON g.id = gp.group_id
           WHERE gp.permission_id = 'perm_core_plugin_export'
           ORDER BY g.id`,
        )
        .all()
        .map((row) => String(row.id)),
    ).toEqual(["grp_admin"]);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM plugin_package_chunks")
        .get()?.count,
    ).toBe(0);
  });
});
