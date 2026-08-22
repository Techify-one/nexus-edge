import { Hono, type Context } from "hono";
import { createId } from "@app/core-contract";
import { sha256, stableJson } from "@app/webhook-contract";
import type { SqlStatement } from "@app/database";
import semver from "semver";
import type { HonoEnv } from "../env.js";
import {
  deletePluginWorker,
  hardenPluginWorker,
  mergeCoreServiceBinding,
  removeCoreServiceBinding,
  uploadPluginWorker,
} from "../installer/cloudflare.js";
import {
  pluginManifestSchema,
  validateManifestPolicy,
  type PluginManifest,
} from "../installer/manifest.js";
import {
  migrationStatements,
  type MigrationSet,
} from "../installer/migrations.js";
import { AppError } from "../lib/http.js";
import { canPermission } from "../lib/ability.js";
import { dbTime } from "../lib/values.js";
import { requirePermission } from "../middleware/auth.js";
import { requireRecentReauth } from "../middleware/reauth.js";
import { audit } from "../services/audit.js";
import { commitWithEvent } from "../services/events.js";
import { idempotencyLookup, saveIdempotency } from "../services/idempotency.js";

type Operation = {
  operationId: string;
  pluginId: string;
  type: string;
  targetVersion: string;
  state: string;
  manifestSha256: string;
  workerSha256: string;
  d1MigrationsSha256: string;
  postgresMigrationsSha256: string;
  lastError: string | null;
};
type PackageParts = {
  manifest: PluginManifest;
  worker: string;
  d1Migrations: MigrationSet;
  postgresMigrations: MigrationSet;
  rawBytes: number;
};

const bindingName = (id: string): string => `PLUGIN_${id.toUpperCase()}`;
const workerName = (id: string): string =>
  `app-plugin-${id.replaceAll("_", "-")}`;
const insertIgnore = (provider: "d1" | "postgres"): string =>
  provider === "d1"
    ? "INSERT OR IGNORE INTO permissions(id,key,created_at) VALUES (?, ?, ?)"
    : "INSERT INTO permissions(id,key,created_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING";
const insertAdminPermission = (provider: "d1" | "postgres"): string =>
  provider === "d1"
    ? "INSERT OR IGNORE INTO group_permissions(group_id,permission_id,created_at) VALUES ('grp_administrators', ?, ?)"
    : "INSERT INTO group_permissions(group_id,permission_id,created_at) VALUES ('grp_administrators', ?, ?) ON CONFLICT (group_id,permission_id) DO NOTHING";

const pluginContextHeader = (
  userId: string,
  permissions: string[],
  requestId: string,
): string => {
  const binary = unescape(
    encodeURIComponent(JSON.stringify({ userId, permissions, requestId })),
  );
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

async function readPackage(c: Context<HonoEnv>): Promise<PackageParts> {
  const length = Number(c.req.header("Content-Length") ?? 0);
  if (length > 4 * 1024 * 1024)
    throw new AppError(
      413,
      "PLUGIN_TOO_LARGE",
      "The package exceeds the 4 MiB raw size limit.",
    );
  const form = await c.req.formData();
  const manifestText = String(form.get("manifest") ?? "");
  const workerValue = form.get("worker");
  const worker =
    workerValue instanceof File
      ? await workerValue.text()
      : String(workerValue ?? "");
  const d1Text = String(form.get("d1Migrations") ?? "{}");
  const postgresText = String(form.get("postgresMigrations") ?? "{}");
  const rawBytes =
    new TextEncoder().encode(manifestText).byteLength +
    new TextEncoder().encode(worker).byteLength +
    new TextEncoder().encode(d1Text).byteLength +
    new TextEncoder().encode(postgresText).byteLength;
  if (rawBytes > 4 * 1024 * 1024)
    throw new AppError(
      413,
      "PLUGIN_TOO_LARGE",
      "The package exceeds the 4 MiB raw size limit.",
    );
  let rawManifest: unknown,
    d1Migrations: MigrationSet,
    postgresMigrations: MigrationSet;
  try {
    rawManifest = JSON.parse(manifestText);
    d1Migrations = JSON.parse(d1Text) as MigrationSet;
    postgresMigrations = JSON.parse(postgresText) as MigrationSet;
  } catch {
    throw new AppError(
      422,
      "PLUGIN_PACKAGE_INVALID",
      "The manifest or migrations do not contain valid JSON.",
    );
  }
  const parsed = pluginManifestSchema.safeParse(rawManifest);
  if (!parsed.success)
    throw new AppError(
      422,
      "PLUGIN_MANIFEST_INVALID",
      "The plugin manifest is invalid.",
    );
  return {
    manifest: parsed.data,
    worker,
    d1Migrations,
    postgresMigrations,
    rawBytes,
  };
}

const hashes = async (parts: PackageParts) => ({
  manifest: await sha256(stableJson(parts.manifest)),
  worker: await sha256(parts.worker),
  d1: await sha256(stableJson(parts.d1Migrations)),
  postgres: await sha256(stableJson(parts.postgresMigrations)),
});

async function getOperation(c: {
  get(name: "db"): HonoEnv["Variables"]["db"];
  req: { param(name: string): string };
}): Promise<Operation> {
  const operation = await c.get("db").first<Operation>(
    `SELECT operation_id AS "operationId", plugin_id AS "pluginId", type, target_version AS "targetVersion", state,
            manifest_sha256 AS "manifestSha256", worker_sha256 AS "workerSha256", d1_migrations_sha256 AS "d1MigrationsSha256",
            postgres_migrations_sha256 AS "postgresMigrationsSha256", last_error AS "lastError"
       FROM plugin_operations WHERE operation_id = ?`,
    [c.req.param("operationId")],
  );
  if (!operation)
    throw new AppError(
      404,
      "PLUGIN_OPERATION_NOT_FOUND",
      "Operation not found.",
    );
  return operation;
}

async function verifyPackage(
  operation: Operation,
  parts: PackageParts,
): Promise<void> {
  const actual = await hashes(parts);
  if (
    actual.manifest !== operation.manifestSha256 ||
    actual.worker !== operation.workerSha256 ||
    actual.d1 !== operation.d1MigrationsSha256 ||
    actual.postgres !== operation.postgresMigrationsSha256
  ) {
    throw new AppError(
      409,
      "PLUGIN_PACKAGE_HASH_MISMATCH",
      "Select the same package used at the beginning of the operation.",
    );
  }
}

const requirePluginOperationPermission = (
  c: Context<HonoEnv>,
  operationType: string,
): void => {
  const key =
    operationType === "update" ? "core.plugin.update" : "core.plugin.create";
  if (!canPermission(c.get("ability"), key))
    throw new AppError(
      403,
      "FORBIDDEN",
      "You do not have permission for this plugin operation.",
    );
};

export const installerRoutes = new Hono<HonoEnv>();

installerRoutes.get(
  "/plugins",
  requirePermission("core.plugin.read"),
  async (c) =>
    c.json({
      items: await c
        .get("db")
        .query(
          `SELECT id, name, installed_version AS "installedVersion", api_version AS "apiVersion", active_database_provider AS "databaseProvider", worker_name AS "workerName", status, installed_at AS "installedAt", updated_at AS "updatedAt" FROM plugins ORDER BY name`,
        ),
    }),
);

installerRoutes.get(
  "/plugin-operations",
  requirePermission("core.plugin.read"),
  async (c) =>
    c.json({
      items: await c.get("db").query(
        `SELECT operation_id AS "operationId", plugin_id AS "pluginId", type, target_version AS "targetVersion", state,
                  CASE WHEN last_error IS NULL THEN 0 ELSE 1 END AS "hasError",
                  created_at AS "createdAt", finished_at AS "finishedAt"
             FROM plugin_operations ORDER BY created_at DESC LIMIT 100`,
      ),
    }),
);

installerRoutes.get(
  "/plugin-operations/:operationId",
  requirePermission("core.plugin.read"),
  async (c) => {
    const operation = await getOperation(c);
    return c.json({
      operationId: operation.operationId,
      pluginId: operation.pluginId,
      type: operation.type,
      targetVersion: operation.targetVersion,
      state: operation.state,
      hasError: Boolean(operation.lastError),
      safeMessage:
        operation.state === "failed"
          ? "The stage failed. Select the same package again to resume."
          : undefined,
    });
  },
);

installerRoutes.post("/plugin-operations", requireRecentReauth, async (c) => {
  const parts = await readPackage(c);
  validateManifestPolicy(
    parts.manifest,
    c.env.APP_VERSION,
    c.env.PLUGIN_COMPATIBILITY_FLAGS,
  );
  if (!parts.worker)
    throw new AppError(422, "PLUGIN_WORKER_MISSING", "worker.mjs is required.");
  const d1Ids = Object.keys(parts.d1Migrations).sort();
  const postgresIds = Object.keys(parts.postgresMigrations).sort();
  if (stableJson(d1Ids) !== stableJson(postgresIds))
    throw new AppError(
      422,
      "PLUGIN_MIGRATIONS_UNPAIRED",
      "D1 and PostgreSQL migrations must have the same IDs.",
    );
  migrationStatements(parts.d1Migrations, parts.manifest.tablePrefix);
  migrationStatements(parts.postgresMigrations, parts.manifest.tablePrefix);
  const installed = await c.get("db").first<{ installedVersion: string }>(
    `SELECT installed_version AS "installedVersion"
           FROM plugins
          WHERE id = ? AND status = 'installed'`,
    [parts.manifest.id],
  );
  if (
    installed &&
    semver.lt(parts.manifest.version, installed.installedVersion)
  )
    throw new AppError(
      409,
      "PLUGIN_DOWNGRADE_NOT_AUTOMATIC",
      "A plugin downgrade requires a documented manual procedure.",
    );
  const operationType = installed ? "update" : "install";
  requirePluginOperationPermission(c, operationType);
  const idem = await idempotencyLookup(
    c,
    "plugin_operations.start",
    { manifest: parts.manifest, hashes: await hashes(parts) },
    true,
  );
  if (idem?.replay)
    return c.json(idem.replay.body as never, idem.replay.status as 201);
  const operationId = createId("pop");
  const now = Date.now();
  const lock = await c
    .get("db")
    .execute(
      `UPDATE installer_lock SET operation_id = ?, acquired_at = ?, expires_at = ? WHERE id = 'global' AND (operation_id IS NULL OR expires_at < ?)`,
      [
        operationId,
        dbTime(c.get("db"), now),
        dbTime(c.get("db"), now + 300_000),
        dbTime(c.get("db"), now),
      ],
    );
  if (!lock.rowsAffected)
    throw new AppError(
      409,
      "INSTALLER_BUSY",
      "Another installation is in progress.",
    );
  const digest = await hashes(parts);
  await c.get("db").execute(
    `INSERT INTO plugin_operations(operation_id, plugin_id, type, target_version, target_api_version, database_provider, manifest_sha256, worker_sha256, d1_migrations_sha256, postgres_migrations_sha256, state, lock_acquired_at, lock_expires_at, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'validating', ?, ?, ?, ?)`,
    [
      operationId,
      parts.manifest.id,
      operationType,
      parts.manifest.version,
      parts.manifest.apiVersion,
      c.env.DATABASE_PROVIDER,
      digest.manifest,
      digest.worker,
      digest.d1,
      digest.postgres,
      dbTime(c.get("db"), now),
      dbTime(c.get("db"), now + 300_000),
      c.get("principal").userId,
      dbTime(c.get("db"), now),
    ],
  );
  const response = {
    operationId,
    pluginId: parts.manifest.id,
    state: "validating",
    rawBytes: parts.rawBytes,
  };
  await saveIdempotency(c, "plugin_operations.start", idem, 201, response);
  await audit(
    c,
    "core.plugin.installation_started",
    "core.plugin",
    parts.manifest.id,
    { operationId, version: parts.manifest.version },
  );
  return c.json(response, 201);
});

installerRoutes.post(
  "/plugin-operations/:operationId/resume",
  requireRecentReauth,
  async (c) => {
    const operation = await getOperation(c);
    requirePluginOperationPermission(c, operation.type);
    if (operation.state !== "failed" || !operation.lastError)
      throw new AppError(
        409,
        "OPERATION_NOT_FAILED",
        "Only a failed operation can be resumed.",
      );
    const failure = JSON.parse(operation.lastError) as { from: string };
    const now = Date.now();
    const lock = await c
      .get("db")
      .execute(
        `UPDATE installer_lock SET operation_id = ?, acquired_at = ?, expires_at = ? WHERE id = 'global' AND (operation_id IS NULL OR operation_id = ? OR expires_at < ?)`,
        [
          operation.operationId,
          dbTime(c.get("db"), now),
          dbTime(c.get("db"), now + 300_000),
          operation.operationId,
          dbTime(c.get("db"), now),
        ],
      );
    if (!lock.rowsAffected)
      throw new AppError(
        409,
        "INSTALLER_BUSY",
        "Another installation is in progress.",
      );
    await c
      .get("db")
      .execute(
        "UPDATE plugin_operations SET state = ?, last_error = NULL WHERE operation_id = ?",
        [failure.from, operation.operationId],
      );
    return c.json({ operationId: operation.operationId, state: failure.from });
  },
);

installerRoutes.post(
  "/plugin-operations/:operationId/advance",
  requireRecentReauth,
  async (c) => {
    const operation = await getOperation(c);
    requirePluginOperationPermission(c, operation.type);
    const db = c.get("db");
    const fail = async (from: string, error: unknown) => {
      const detail =
        error instanceof Error ? error.message.slice(0, 500) : "unknown";
      await db.execute(
        "UPDATE plugin_operations SET state = 'failed', last_error = ? WHERE operation_id = ?",
        [JSON.stringify({ from, detail }), operation.operationId],
      );
      throw new AppError(
        500,
        "PLUGIN_OPERATION_FAILED",
        "The stage failed. Check the operation code and try to resume.",
      );
    };
    try {
      if (operation.state === "validating") {
        const parts = await readPackage(c);
        await verifyPackage(operation, parts);
        validateManifestPolicy(
          parts.manifest,
          c.env.APP_VERSION,
          c.env.PLUGIN_COMPATIBILITY_FLAGS,
        );
        await db.execute(
          "UPDATE plugin_operations SET state = 'migrating', lock_expires_at = ? WHERE operation_id = ?",
          [dbTime(db, Date.now() + 300_000), operation.operationId],
        );
        const activeSet =
          c.env.DATABASE_PROVIDER === "d1"
            ? parts.d1Migrations
            : parts.postgresMigrations;
        const migrations = migrationStatements(
          activeSet,
          parts.manifest.tablePrefix,
        );
        const statements: SqlStatement[] = [];
        for (const migration of migrations) {
          const digest = await sha256(activeSet[migration.migrationId]!);
          const existing = await db.first<{ sha256: string }>(
            "SELECT sha256 FROM plugin_migrations WHERE plugin_id = ? AND dialect = ? AND migration_id = ?",
            [
              operation.pluginId,
              c.env.DATABASE_PROVIDER,
              migration.migrationId,
            ],
          );
          if (existing && existing.sha256 !== digest)
            throw new Error(
              `Migration hash mismatch: ${migration.migrationId}`,
            );
          if (!existing)
            statements.push(...migration.statements, {
              sql: "INSERT INTO plugin_migrations(plugin_id, dialect, migration_id, sha256, applied_at) VALUES (?, ?, ?, ?, ?)",
              params: [
                operation.pluginId,
                c.env.DATABASE_PROVIDER,
                migration.migrationId,
                digest,
                dbTime(db),
              ],
            });
        }
        await db.atomic(statements);
        await db.execute(
          "UPDATE plugin_operations SET state = 'deploying' WHERE operation_id = ?",
          [operation.operationId],
        );
        return c.json({
          operationId: operation.operationId,
          state: "deploying",
        });
      }
      if (operation.state === "deploying") {
        const parts = await readPackage(c);
        await verifyPackage(operation, parts);
        await uploadPluginWorker(
          c.env,
          workerName(operation.pluginId),
          parts.worker,
          parts.manifest,
        );
        await db.execute(
          "UPDATE plugin_operations SET state = 'hardening' WHERE operation_id = ?",
          [operation.operationId],
        );
        return c.json({
          operationId: operation.operationId,
          state: "hardening",
        });
      }
      if (operation.state === "hardening") {
        await hardenPluginWorker(c.env, workerName(operation.pluginId));
        await db.execute(
          "UPDATE plugin_operations SET state = 'binding' WHERE operation_id = ?",
          [operation.operationId],
        );
        return c.json({ operationId: operation.operationId, state: "binding" });
      }
      if (operation.state === "binding") {
        await mergeCoreServiceBinding(
          c.env,
          bindingName(operation.pluginId),
          workerName(operation.pluginId),
        );
        await db.execute(
          "UPDATE plugin_operations SET state = 'registering' WHERE operation_id = ?",
          [operation.operationId],
        );
        return c.json({
          operationId: operation.operationId,
          state: "registering",
        });
      }
      if (operation.state === "registering") {
        const parts = await readPackage(c);
        await verifyPackage(operation, parts);
        const binding =
          c.env[bindingName(operation.pluginId) as `PLUGIN_${string}`];
        if (!binding || typeof (binding as Fetcher).fetch !== "function")
          throw new Error(
            "The Service Binding is not available for the smoke test yet",
          );
        const smoke = await (binding as Fetcher).fetch(
          new Request("https://plugin.internal/__installer/smoke", {
            method: "POST",
            headers: {
              "X-Plugin-Context": pluginContextHeader(
                c.get("principal").userId,
                parts.manifest.permissions,
                c.get("requestId"),
              ),
            },
          }),
        );
        if (!smoke.ok)
          throw new Error(`Plugin smoke test failed (${smoke.status})`);
        const now = dbTime(db);
        const permissionIds = parts.manifest.permissions.map(
          (key) => `perm_${key.replaceAll(".", "_")}`,
        );
        await commitWithEvent(
          c,
          [
            {
              sql: `INSERT INTO plugins(id, name, installed_version, api_version, database_dialects_json, active_database_provider, worker_name, status, manifest_json, installed_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'installed', ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, installed_version=excluded.installed_version, api_version=excluded.api_version, status='installed', manifest_json=excluded.manifest_json, updated_at=excluded.updated_at`,
              params: [
                parts.manifest.id,
                parts.manifest.name,
                parts.manifest.version,
                parts.manifest.apiVersion,
                JSON.stringify(parts.manifest.databaseDialects),
                c.env.DATABASE_PROVIDER,
                workerName(parts.manifest.id),
                JSON.stringify(parts.manifest),
                now,
                now,
              ],
            },
            ...parts.manifest.permissions.map((key) => ({
              sql: insertIgnore(db.provider),
              params: [`perm_${key.replaceAll(".", "_")}`, key, now],
            })),
            ...permissionIds.map((permissionId) => ({
              sql: insertAdminPermission(db.provider),
              params: [permissionId, now],
            })),
            {
              sql: "UPDATE plugin_operations SET state = 'installed', finished_at = ? WHERE operation_id = ?",
              params: [now, operation.operationId],
            },
            {
              sql: "UPDATE installer_lock SET operation_id = NULL, acquired_at = NULL, expires_at = NULL WHERE id = 'global' AND operation_id = ?",
              params: [operation.operationId],
            },
          ],
          {
            eventType: "core.plugin.installation_succeeded",
            resourceType: "core.plugin",
            resourceId: operation.pluginId,
            data: {
              version: operation.targetVersion,
              workerName: workerName(operation.pluginId),
            },
          },
        );
        await audit(
          c,
          "core.plugin.installation_succeeded",
          "core.plugin",
          operation.pluginId,
          {
            operationId: operation.operationId,
            version: operation.targetVersion,
          },
        );
        return c.json({
          operationId: operation.operationId,
          state: "installed",
        });
      }
      throw new AppError(
        409,
        "OPERATION_NOT_ADVANCEABLE",
        "The operation cannot advance from its current state.",
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      return fail(operation.state, error);
    }
  },
);

installerRoutes.delete(
  "/plugins/:pluginId",
  requirePermission("core.plugin.delete"),
  requireRecentReauth,
  async (c) => {
    const pluginId = c.req.param("pluginId");
    const plugin = await c
      .get("db")
      .first<{ workerName: string }>(
        `SELECT worker_name AS "workerName" FROM plugins WHERE id = ? AND status = 'installed'`,
        [pluginId],
      );
    if (!plugin)
      throw new AppError(404, "PLUGIN_NOT_FOUND", "Plugin not found.");
    await c
      .get("db")
      .execute(
        "UPDATE plugins SET status = 'uninstalling', updated_at = ? WHERE id = ?",
        [dbTime(c.get("db")), pluginId],
      );
    await removeCoreServiceBinding(c.env, bindingName(pluginId));
    await deletePluginWorker(c.env, plugin.workerName);
    await commitWithEvent(
      c,
      [
        {
          sql: "DELETE FROM group_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key LIKE ?)",
          params: [`${pluginId}.%`],
        },
        {
          sql: "DELETE FROM permissions WHERE key LIKE ?",
          params: [`${pluginId}.%`],
        },
        {
          sql: "UPDATE plugins SET status = 'uninstalled', updated_at = ? WHERE id = ?",
          params: [dbTime(c.get("db")), pluginId],
        },
      ],
      {
        eventType: "core.plugin.uninstalled",
        resourceType: "core.plugin",
        resourceId: pluginId,
        data: { tablesPreserved: true },
      },
    );
    await audit(c, "core.plugin.uninstalled", "core.plugin", pluginId);
    return c.body(null, 204);
  },
);
