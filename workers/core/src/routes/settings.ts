import { Hono, type Context } from "hono";
import { createId } from "@app/core-contract";
import semver from "semver";
import type { HonoEnv } from "../env.js";
import {
  deployCoreUpdate,
  verifyCoreUpdateBindings,
} from "../installer/cloudflare.js";
import { AppError, noStore } from "../lib/http.js";
import { dbTime } from "../lib/values.js";
import { requirePermission } from "../middleware/auth.js";
import { requireRecentReauth } from "../middleware/reauth.js";
import { audit } from "../services/audit.js";
import { applyCoreUpdateMigrations } from "../updates/migrations.js";
import {
  coreUpdateStatus,
  discoverLatestCoreRelease,
  downloadVerifiedCoreArchive,
  readPinnedCoreRelease,
} from "../updates/release.js";

type UpdateOperation = {
  operationId: string;
  releaseId: string;
  targetVersion: string;
  manifestSha256: string;
  state: "migrating" | "deploying" | "verifying" | "installed" | "failed";
  restoreTimestamp: unknown | null;
  lastError: string | null;
  createdAt: unknown;
  updatedAt: unknown;
  completedAt: unknown | null;
};

const operationSelect = `SELECT
  operation_id AS "operationId", release_id AS "releaseId",
  target_version AS "targetVersion", manifest_sha256 AS "manifestSha256",
  state, restore_timestamp AS "restoreTimestamp", last_error AS "lastError",
  created_at AS "createdAt", updated_at AS "updatedAt",
  completed_at AS "completedAt"
  FROM core_update_operations`;

const publicOperation = (operation: UpdateOperation | null) =>
  operation
    ? {
        operationId: operation.operationId,
        targetVersion: operation.targetVersion,
        state: operation.state,
        restoreTimestamp: operation.restoreTimestamp,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
        completedAt: operation.completedAt,
        ...(operation.lastError
          ? { failureCode: "CORE_UPDATE_STAGE_FAILED" }
          : {}),
      }
    : null;

async function operationById(c: Context<HonoEnv>): Promise<UpdateOperation> {
  const id = c.req.param("operationId") ?? "";
  if (!/^cup_[A-Za-z0-9_-]{1,100}$/u.test(id))
    throw new AppError(
      404,
      "CORE_UPDATE_NOT_FOUND",
      "Update operation not found.",
    );
  const operation = await c
    .get("db")
    .first<UpdateOperation>(`${operationSelect} WHERE operation_id = ?`, [id]);
  if (!operation)
    throw new AppError(
      404,
      "CORE_UPDATE_NOT_FOUND",
      "Update operation not found.",
    );
  return operation;
}

async function assertPinnedRelease(
  c: Context<HonoEnv>,
  operation: UpdateOperation,
) {
  const release = await readPinnedCoreRelease(c.env, operation.releaseId);
  if (
    release.manifest.appVersion !== operation.targetVersion ||
    release.manifestHash !== operation.manifestSha256
  )
    throw new Error("CORE_UPDATE_PIN_MISMATCH");
  return release;
}

async function failOperation(
  c: Context<HonoEnv>,
  operation: UpdateOperation,
  error: unknown,
): Promise<never> {
  const detail = error instanceof Error ? error.message : "unknown";
  await c.get("db").atomic([
    {
      sql: `UPDATE core_update_operations
            SET state = 'failed', last_error = ?, updated_at = ?
            WHERE operation_id = ?`,
      params: [
        JSON.stringify({
          stage: operation.state,
          detail: detail.slice(0, 300),
          requestId: c.get("requestId"),
        }),
        dbTime(c.get("db")),
        operation.operationId,
      ],
    },
    {
      sql: `UPDATE installer_lock SET operation_id = NULL,
            acquired_at = NULL, expires_at = NULL
            WHERE id = 'global' AND operation_id = ?`,
      params: [operation.operationId],
    },
  ]);
  await audit(
    c,
    "core.settings.update_failed",
    "core.update",
    operation.operationId,
    {
      version: operation.targetVersion,
      stage: operation.state,
      requestId: c.get("requestId"),
    },
  );
  throw new AppError(
    500,
    "CORE_UPDATE_STAGE_FAILED",
    "The update stage failed. No unsigned files were installed.",
  );
}

export const settingsRoutes = new Hono<HonoEnv>();

settingsRoutes.get(
  "/settings/general",
  requirePermission("core.settings.read"),
  async (c) => {
    const [status, active] = await Promise.all([
      coreUpdateStatus(c.env),
      c
        .get("db")
        .first<UpdateOperation>(
          `${operationSelect} WHERE state NOT IN ('installed', 'failed') ORDER BY created_at DESC`,
        ),
    ]);
    return c.json(
      { ...status, activeOperation: publicOperation(active) },
      200,
      noStore,
    );
  },
);

settingsRoutes.get(
  "/settings/core-update-operations/:operationId",
  requirePermission("core.settings.read"),
  async (c) => c.json(publicOperation(await operationById(c)), 200, noStore),
);

settingsRoutes.post(
  "/settings/core-update-operations",
  requirePermission("core.settings.update"),
  requireRecentReauth,
  async (c) => {
    if (c.env.DATABASE_PROVIDER !== "d1")
      throw new AppError(
        409,
        "CORE_UPDATE_PROVIDER_UNSUPPORTED",
        "Beta updates currently support D1 installations only.",
      );
    if (!c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID)
      throw new AppError(
        409,
        "CORE_UPDATE_CREDENTIAL_REQUIRED",
        "Configure the limited Cloudflare credential on the Plugins page first.",
      );
    const release = await discoverLatestCoreRelease(c.env).catch(() => null);
    if (!release)
      throw new AppError(
        503,
        "CORE_UPDATE_SOURCE_UNAVAILABLE",
        "GitHub releases are unavailable.",
      );
    if (!semver.gt(release.manifest.appVersion, c.env.APP_VERSION))
      throw new AppError(
        409,
        "CORE_UPDATE_NOT_AVAILABLE",
        "This installation is already current.",
      );

    const operationId = createId("cup");
    const now = Date.now();
    await c.get("db").execute(
      `UPDATE installer_lock SET operation_id = NULL, acquired_at = NULL, expires_at = NULL
       WHERE id = 'global' AND operation_id IN
         (SELECT operation_id FROM core_update_operations WHERE state = 'failed')`,
    );
    const lock = await c.get("db").execute(
      `UPDATE installer_lock SET operation_id = ?, acquired_at = ?, expires_at = ?
       WHERE id = 'global' AND (operation_id IS NULL OR expires_at < ?)`,
      [
        operationId,
        dbTime(c.get("db"), now),
        dbTime(c.get("db"), now + 600_000),
        dbTime(c.get("db"), now),
      ],
    );
    if (!lock.rowsAffected)
      throw new AppError(
        409,
        "INSTALLER_BUSY",
        "Another installation or update is in progress.",
      );
    try {
      await c.get("db").execute(
        `INSERT INTO core_update_operations(
           operation_id, release_id, target_version, manifest_sha256, state,
           created_by_user_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'migrating', ?, ?, ?)`,
        [
          operationId,
          release.releaseId,
          release.manifest.appVersion,
          release.manifestHash,
          c.get("principal").userId,
          dbTime(c.get("db"), now),
          dbTime(c.get("db"), now),
        ],
      );
    } catch (error) {
      await c.get("db").execute(
        `UPDATE installer_lock SET operation_id = NULL, acquired_at = NULL,
         expires_at = NULL WHERE id = 'global' AND operation_id = ?`,
        [operationId],
      );
      throw error;
    }
    await audit(c, "core.settings.update_started", "core.update", operationId, {
      version: release.manifest.appVersion,
    });
    return c.json(
      publicOperation(
        await c
          .get("db")
          .first<UpdateOperation>(`${operationSelect} WHERE operation_id = ?`, [
            operationId,
          ]),
      ),
      201,
      noStore,
    );
  },
);

settingsRoutes.post(
  "/settings/core-update-operations/:operationId/advance",
  requirePermission("core.settings.update"),
  requireRecentReauth,
  async (c) => {
    const operation = await operationById(c);
    if (operation.state === "installed" || operation.state === "failed")
      return c.json(publicOperation(operation), 200, noStore);
    try {
      if (operation.state === "migrating") {
        const release = await assertPinnedRelease(c, operation);
        const restoreTimestamp = Date.now();
        await c.get("db").execute(
          `UPDATE core_update_operations SET restore_timestamp = ?, updated_at = ?
           WHERE operation_id = ?`,
          [
            dbTime(c.get("db"), restoreTimestamp),
            dbTime(c.get("db")),
            operation.operationId,
          ],
        );
        const archive = await downloadVerifiedCoreArchive(release);
        await applyCoreUpdateMigrations(c.get("db"), release.manifest, archive);
        await c.get("db").execute(
          `UPDATE core_update_operations SET state = 'deploying', updated_at = ?
           WHERE operation_id = ?`,
          [dbTime(c.get("db")), operation.operationId],
        );
      } else if (operation.state === "deploying") {
        const release = await assertPinnedRelease(c, operation);
        const archive = await downloadVerifiedCoreArchive(release);
        await deployCoreUpdate(c.env, release.manifest, archive);
        await c.get("db").execute(
          `UPDATE core_update_operations SET state = 'verifying', updated_at = ?
           WHERE operation_id = ?`,
          [dbTime(c.get("db")), operation.operationId],
        );
      } else if (operation.state === "verifying") {
        if (c.env.APP_VERSION !== operation.targetVersion) {
          const updatedAt =
            operation.updatedAt instanceof Date
              ? operation.updatedAt.getTime()
              : Number(operation.updatedAt);
          if (Number.isFinite(updatedAt) && Date.now() - updatedAt < 120_000)
            return c.json(publicOperation(operation), 202, noStore);
          throw new Error("CORE_UPDATE_VERSION_NOT_ACTIVE");
        }
        await verifyCoreUpdateBindings(c.env);
        await c.get("db").atomic([
          {
            sql: `UPDATE core_update_operations SET state = 'installed',
                  updated_at = ?, completed_at = ? WHERE operation_id = ?`,
            params: [
              dbTime(c.get("db")),
              dbTime(c.get("db")),
              operation.operationId,
            ],
          },
          {
            sql: `UPDATE installer_lock SET operation_id = NULL,
                  acquired_at = NULL, expires_at = NULL
                  WHERE id = 'global' AND operation_id = ?`,
            params: [operation.operationId],
          },
        ]);
        await audit(
          c,
          "core.settings.update_succeeded",
          "core.update",
          operation.operationId,
          {
            version: operation.targetVersion,
          },
        );
      }
      return c.json(
        publicOperation(
          await c
            .get("db")
            .first<UpdateOperation>(
              `${operationSelect} WHERE operation_id = ?`,
              [operation.operationId],
            ),
        ),
        200,
        noStore,
      );
    } catch (error) {
      return failOperation(c, operation, error);
    }
  },
);
