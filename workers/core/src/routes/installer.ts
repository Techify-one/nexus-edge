import { Hono, type Context } from "hono";
import { createId, type PluginInstallerContext } from "@app/core-contract";
import { sha256, stableJson } from "@app/webhook-contract";
import type { SqlStatement } from "@app/database";
import semver from "semver";
import type { HonoEnv } from "../env.js";
import {
  deletePluginSecret,
  deletePluginWorker,
  configurePluginRuntimeCredential,
  hardenPluginWorker,
  mergeCoreServiceBinding,
  PluginRuntimeCredentialError,
  pluginSecretConfigured,
  pluginRuntimeCredentialStatus,
  provisionR2Bucket,
  putPluginSecret,
  removeCoreServiceBinding,
  R2ProvisioningError,
  uploadPluginWorker,
} from "../installer/cloudflare.js";
import {
  PluginManifestPolicyError,
  pluginManifestSchema,
  validateManifestPolicy,
  type PluginManifest,
} from "../installer/manifest.js";
import {
  migrationStatements,
  type MigrationSet,
} from "../installer/migrations.js";
import {
  archivePackageStatements,
  assertNoRuntimeValues,
  loadPortablePackage,
  portablePackageZip,
  verifyPortablePackage,
} from "../installer/package-archive.js";
import { AppError, noStore } from "../lib/http.js";
import { canPermission } from "../lib/ability.js";
import { dbTime } from "../lib/values.js";
import { requirePermission } from "../middleware/auth.js";
import { validateRecentReauth } from "../middleware/reauth.js";
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

const failureStages = new Set([
  "validating",
  "provisioning",
  "migrating",
  "deploying",
  "hardening",
  "binding",
  "registering",
]);

const safeFailureSummary = (
  lastError: string | null,
): {
  failureStage: string;
  failureReason: string;
  failureDetail: string;
  failureRequestId?: string;
  failedAt?: number;
} | null => {
  if (!lastError) return null;
  try {
    const failure = JSON.parse(lastError) as {
      from?: unknown;
      detail?: unknown;
      requestId?: unknown;
      failedAt?: unknown;
    };
    const failureStage =
      typeof failure.from === "string" && failureStages.has(failure.from)
        ? failure.from
        : "unknown";
    const detail = typeof failure.detail === "string" ? failure.detail : "";
    const metadata = {
      ...(typeof failure.requestId === "string" &&
      /^req_[A-Za-z0-9_-]{1,100}$/u.test(failure.requestId)
        ? { failureRequestId: failure.requestId }
        : {}),
      ...(typeof failure.failedAt === "number" &&
      Number.isFinite(failure.failedAt)
        ? { failedAt: failure.failedAt }
        : {}),
    };
    if (detail === "CF_API_TOKEN and CF_ACCOUNT_ID must be configured")
      return {
        failureStage,
        failureReason: "installer_credentials_missing",
        failureDetail: "Installer Cloudflare credentials are not configured.",
        ...metadata,
      };
    const cloudflare =
      /^Cloudflare API failed \((\d{3})\): ([0-9,]+|unknown)$/u.exec(detail);
    if (cloudflare)
      return {
        failureStage,
        failureReason: `cloudflare_api_${cloudflare[1]}_${cloudflare[2]}`,
        failureDetail: `Cloudflare API returned HTTP ${cloudflare[1]} with code(s) ${cloudflare[2]}.`,
        ...metadata,
      };
    const smoke = /^Plugin smoke test failed \((\d{3})\)$/u.exec(detail);
    if (smoke)
      return {
        failureStage,
        failureReason: "plugin_smoke_test_failed",
        failureDetail: `Plugin smoke test returned HTTP ${smoke[1]}.`,
        ...metadata,
      };
    if (detail.includes("Service Binding is not available"))
      return {
        failureStage,
        failureReason: "service_binding_pending",
        failureDetail:
          "The plugin Service Binding was not available to the Core smoke test.",
        ...metadata,
      };
    const migration = /^Migration hash mismatch: ([A-Za-z0-9_-]{1,100})$/u.exec(
      detail,
    );
    if (migration)
      return {
        failureStage,
        failureReason: "migration_hash_mismatch",
        failureDetail: `Migration ${migration[1]} has a different stored hash.`,
        ...metadata,
      };
    if (
      detail ===
      "Select the same package used at the beginning of the operation."
    )
      return {
        failureStage,
        failureReason: "plugin_package_hash_mismatch",
        failureDetail:
          "The selected package hashes differ from the original operation.",
        ...metadata,
      };
    return {
      failureStage,
      failureReason: "unexpected_stage_failure",
      failureDetail:
        "Unexpected Installer stage failure. Use the request ID to locate server logs.",
      ...metadata,
    };
  } catch {
    return {
      failureStage: "unknown",
      failureReason: "invalid_failure_record",
      failureDetail:
        "The persisted failure record could not be decoded. Use the operation ID to locate server logs.",
    };
  }
};

const bindingName = (id: string): string => `PLUGIN_${id.toUpperCase()}`;
const workerName = (id: string): string =>
  `app-plugin-${id.replaceAll("_", "-")}`;
const allowedRuntimeSecrets = new Map<
  string,
  { names: Set<string>; permissionResource: string }
>([
  [
    "meta_ads",
    { names: new Set(["META_ACCESS_TOKEN"]), permissionResource: "account" },
  ],
  [
    "meeting_recorder",
    {
      names: new Set(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]),
      permissionResource: "settings",
    },
  ],
]);

const runtimeSecretTarget = async (
  c: Context<HonoEnv>,
  access: "read" | "update",
) => {
  const pluginId = c.req.param("pluginId") ?? "";
  const secretName = c.req.param("secretName") ?? "";
  const policy = allowedRuntimeSecrets.get(pluginId);
  if (!policy?.names.has(secretName))
    throw new AppError(404, "PLUGIN_SECRET_NOT_FOUND", "Secret not found.");
  if (
    !canPermission(
      c.get("ability"),
      `${pluginId}.${policy.permissionResource}.${access}`,
    )
  )
    throw new AppError(403, "FORBIDDEN", "Permission denied.");
  const plugin = await c
    .get("db")
    .first<{ workerName: string; status: string }>(
      `SELECT worker_name AS "workerName", status FROM plugins WHERE id = ?`,
      [pluginId],
    );
  if (!plugin || plugin.status !== "installed")
    throw new AppError(404, "PLUGIN_NOT_INSTALLED", "Plugin is not installed.");
  return { pluginId, secretName, workerName: plugin.workerName };
};
const insertIgnore = (provider: "d1" | "postgres"): string =>
  provider === "d1"
    ? "INSERT OR IGNORE INTO permissions(id,key,created_at) VALUES (?, ?, ?)"
    : "INSERT INTO permissions(id,key,created_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING";
const insertAdminPermission = (provider: "d1" | "postgres"): string =>
  provider === "d1"
    ? "INSERT OR IGNORE INTO group_permissions(group_id,permission_id,created_at) VALUES ('grp_administrators', ?, ?)"
    : "INSERT INTO group_permissions(group_id,permission_id,created_at) VALUES ('grp_administrators', ?, ?) ON CONFLICT (group_id,permission_id) DO NOTHING";

// Cloudflare account-owned API tokens use the newer `cfat_` opaque format and
// can be considerably longer than legacy user tokens. Keep a bounded input,
// but do not assume the old 80/200-character representation.
const validCloudflareTokenLength = (token: string): boolean =>
  token.length >= 40 && token.length <= 2_048;

const encodedContextHeader = (context: unknown): string => {
  const binary = unescape(encodeURIComponent(JSON.stringify(context)));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const deterministicR2BucketName = async (
  installationId: string,
  pluginId: string,
) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(installationId),
    ),
  );
  const prefix = [...digest]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const pluginSlug = pluginId.replaceAll("_", "-").slice(0, 43);
  return `nexus-${prefix}-${pluginSlug}`;
};

const runtimeBoundaryValues = async (
  c: Context<HonoEnv>,
  pluginId: string,
): Promise<Array<string | undefined>> => {
  const resources = await c.get("db").query<{ externalName: string }>(
    `SELECT external_name AS "externalName"
         FROM plugin_runtime_resources WHERE plugin_id = ?`,
    [pluginId],
  );
  return [
    ...resources.map((resource) => resource.externalName),
    c.env.APP_INSTALLATION_ID
      ? await deterministicR2BucketName(c.env.APP_INSTALLATION_ID, pluginId)
      : undefined,
  ];
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

const verifyPortablePackageBoundary = (
  env: HonoEnv["Bindings"],
  parts: PackageParts,
  resourceValues: Array<string | undefined> = [],
): void => {
  try {
    assertNoRuntimeValues(parts, [
      env.APP_INSTALLATION_ID,
      env.BETTER_AUTH_SECRET,
      env.WEBHOOK_ENCRYPTION_KEY,
      env.CF_API_TOKEN,
      env.CF_ACCOUNT_ID,
      env.DATABASE_URL,
      env.D1_DATABASE_ID,
      env.HYPERDRIVE_ID,
      env.BETTER_AUTH_URL,
      env.TRUSTED_ORIGINS,
      env.CORE_WORKER_NAME,
      env.WEBHOOK_ALLOWED_DOMAINS,
      ...resourceValues,
    ]);
  } catch {
    throw new AppError(
      422,
      "PLUGIN_PACKAGE_CONTAINS_RUNTIME_VALUE",
      "Plugin packages cannot contain installation-specific runtime values.",
    );
  }
};

const validatePackagePolicy = (
  c: Context<HonoEnv>,
  manifest: PluginManifest,
): void => {
  try {
    validateManifestPolicy(
      manifest,
      c.env.APP_VERSION,
      c.env.PLUGIN_COMPATIBILITY_FLAGS,
    );
  } catch (error) {
    if (!(error instanceof PluginManifestPolicyError)) throw error;
    const mapped =
      error.code === "core_version_unsupported"
        ? [
            409,
            "PLUGIN_CORE_VERSION_UNSUPPORTED",
            `This plugin requires Core ${manifest.coreMinVersion} or newer.`,
          ]
        : error.code === "api_version_unsupported"
          ? [
              422,
              "PLUGIN_API_VERSION_UNSUPPORTED",
              "The plugin API version is not supported by this Core.",
            ]
          : error.code === "compatibility_flag_unsupported"
            ? [
                422,
                "PLUGIN_COMPATIBILITY_FLAG_UNSUPPORTED",
                "The plugin requests an unsupported compatibility flag.",
              ]
            : [
                422,
                "PLUGIN_FRONTEND_UNAVAILABLE",
                "The plugin frontend is not available in this Core version.",
              ];
    throw new AppError(
      mapped[0] as 409 | 422,
      mapped[1] as string,
      mapped[2] as string,
    );
  }
};

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
  "/plugin-runtime-credential",
  requirePermission("core.plugin.read"),
  (c) => {
    try {
      return c.json(pluginRuntimeCredentialStatus(c.env), 200, noStore);
    } catch (error) {
      if (
        error instanceof PluginRuntimeCredentialError &&
        error.code === "target_missing"
      )
        throw new AppError(
          503,
          "PLUGIN_RUNTIME_CREDENTIAL_TARGET_MISSING",
          "The Cloudflare account target is not configured.",
        );
      throw error;
    }
  },
);

installerRoutes.put(
  "/plugin-runtime-credential",
  requirePermission("core.plugin.create"),
  async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      token?: unknown;
    } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!validCloudflareTokenLength(token))
      throw new AppError(
        422,
        "PLUGIN_RUNTIME_CREDENTIAL_INVALID",
        "Enter a valid Cloudflare API Token.",
      );
    try {
      await configurePluginRuntimeCredential(c.env, token);
    } catch (error) {
      if (error instanceof PluginRuntimeCredentialError) {
        if (error.code === "too_broad")
          throw new AppError(
            422,
            "PLUGIN_RUNTIME_CREDENTIAL_TOO_BROAD",
            "Use a token limited to Workers Scripts Edit on this account.",
          );
        if (error.code === "invalid")
          throw new AppError(
            422,
            "PLUGIN_RUNTIME_CREDENTIAL_INVALID",
            "The token is invalid, belongs to another account, or lacks Workers Scripts Edit.",
          );
        if (error.code === "target_missing")
          throw new AppError(
            503,
            "PLUGIN_RUNTIME_CREDENTIAL_TARGET_MISSING",
            "The Cloudflare account target is not configured.",
          );
        throw new AppError(
          503,
          "PLUGIN_RUNTIME_CREDENTIAL_SAVE_FAILED",
          "Cloudflare could not save the plugin credential.",
        );
      }
      throw error;
    }
    await audit(
      c,
      "core.plugin.runtime_credential_configured",
      "core.plugin",
      "cloudflare",
      {},
    );
    return c.json(
      { ...pluginRuntimeCredentialStatus(c.env), configured: true },
      200,
      noStore,
    );
  },
);

installerRoutes.get(
  "/plugins",
  requirePermission("core.plugin.read"),
  async (c) =>
    c.json({
      items: await c.get("db").query(
        `SELECT p.id, p.name, p.installed_version AS "installedVersion", p.api_version AS "apiVersion",
                  p.active_database_provider AS "databaseProvider", p.worker_name AS "workerName", p.status,
                  p.installed_at AS "installedAt", p.updated_at AS "updatedAt",
                  (SELECT pr.status FROM plugin_runtime_resources pr
                    WHERE pr.plugin_id = p.id AND pr.binding_name = 'STORAGE') AS "runtimeStorageStatus",
                  CASE WHEN p.status = 'installed' AND EXISTS (
                    SELECT 1 FROM plugin_operations po
                    JOIN plugin_package_chunks pc ON pc.operation_id = po.operation_id
                    WHERE po.plugin_id = p.id AND po.target_version = p.installed_version AND po.state = 'installed'
                  ) THEN 1 ELSE 0 END AS "packageAvailable"
             FROM plugins p ORDER BY p.name`,
      ),
    }),
);

installerRoutes.get(
  "/plugins/:pluginId/runtime-secrets/:secretName",
  async (c) => {
    const target = await runtimeSecretTarget(c, "read");
    return c.json(
      {
        configured: await pluginSecretConfigured(
          c.env,
          target.workerName,
          target.secretName,
        ),
      },
      200,
      noStore,
    );
  },
);

installerRoutes.put(
  "/plugins/:pluginId/runtime-secrets/:secretName",
  async (c) => {
    const target = await runtimeSecretTarget(c, "update");
    await validateRecentReauth(c);
    const body = (await c.req.json().catch(() => null)) as {
      value?: unknown;
    } | null;
    const value = typeof body?.value === "string" ? body.value.trim() : "";
    if (value.length < 20 || value.length > 8_192)
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "The secret value is invalid.",
      );
    await putPluginSecret(c.env, target.workerName, target.secretName, value);
    await audit(
      c,
      "core.plugin.runtime_secret_configured",
      "core.plugin",
      target.pluginId,
      { secretName: target.secretName },
    );
    return c.json({ configured: true }, 200, noStore);
  },
);

installerRoutes.delete(
  "/plugins/:pluginId/runtime-secrets/:secretName",
  async (c) => {
    const target = await runtimeSecretTarget(c, "update");
    await validateRecentReauth(c);
    await deletePluginSecret(c.env, target.workerName, target.secretName);
    await audit(
      c,
      "core.plugin.runtime_secret_deleted",
      "core.plugin",
      target.pluginId,
      { secretName: target.secretName },
    );
    return c.body(null, 204);
  },
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
    const failure = safeFailureSummary(operation.lastError);
    return c.json({
      operationId: operation.operationId,
      pluginId: operation.pluginId,
      type: operation.type,
      targetVersion: operation.targetVersion,
      state: operation.state,
      hasError: Boolean(operation.lastError),
      safeMessage:
        operation.state === "failed"
          ? "The stage failed. Copy the safe support report and use its operation and request IDs to investigate."
          : undefined,
      ...(failure ?? {}),
    });
  },
);

installerRoutes.post("/plugin-operations", async (c) => {
  const parts = await readPackage(c);
  validatePackagePolicy(c, parts.manifest);
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
  verifyPortablePackageBoundary(
    c.env,
    parts,
    await runtimeBoundaryValues(c, parts.manifest.id),
  );
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
  if (!c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID)
    throw new AppError(
      409,
      "PLUGIN_RUNTIME_CREDENTIAL_REQUIRED",
      "Configure the limited Cloudflare credential before installing a plugin.",
    );
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
  await c.get("db").execute(
    `UPDATE installer_lock
        SET operation_id = NULL, acquired_at = NULL, expires_at = NULL
      WHERE id = 'global'
        AND operation_id IN (SELECT operation_id FROM plugin_operations WHERE state = 'failed')`,
  );
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

installerRoutes.post("/plugin-operations/:operationId/resume", async (c) => {
  const operation = await getOperation(c);
  requirePluginOperationPermission(c, operation.type);
  if (operation.state !== "failed" || !operation.lastError)
    throw new AppError(
      409,
      "OPERATION_NOT_FAILED",
      "Only a failed operation can be resumed.",
    );
  const failure = JSON.parse(operation.lastError) as { from: string };
  const preservedResource = await c.get("db").first<{ status: string }>(
    `SELECT status FROM plugin_runtime_resources
      WHERE plugin_id = ? AND binding_name = 'STORAGE'
        AND created_by_operation_id = ? AND status IN ('preserved','missing')`,
    [operation.pluginId, operation.operationId],
  );
  const resumeState = preservedResource ? "provisioning" : failure.from;
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
      [resumeState, operation.operationId],
    );
  return c.json({ operationId: operation.operationId, state: resumeState });
});

installerRoutes.post(
  "/plugin-operations/:operationId/provision-r2",
  async (c) => {
    const operation = await getOperation(c);
    requirePluginOperationPermission(c, operation.type);
    await validateRecentReauth(c);
    if (!(c.req.header("Idempotency-Key") ?? "").trim())
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key is required for R2 provisioning.",
      );
    if (operation.state === "migrating") {
      const ready = await c.get("db").first<{ operationId: string }>(
        `SELECT created_by_operation_id AS "operationId"
           FROM plugin_runtime_resources
          WHERE plugin_id = ? AND binding_name = 'STORAGE' AND status = 'ready'`,
        [operation.pluginId],
      );
      if (ready?.operationId === operation.operationId)
        return c.json({
          operationId: operation.operationId,
          state: "migrating",
          resource: { type: "r2", binding: "STORAGE" },
          replay: true,
        });
    }
    if (operation.state !== "provisioning")
      throw new AppError(
        409,
        "OPERATION_NOT_PROVISIONING",
        "This operation is not waiting for R2 provisioning.",
      );
    if (!c.env.CF_ACCOUNT_ID || !c.env.APP_INSTALLATION_ID)
      throw new AppError(
        503,
        "R2_PROVISIONING_TARGET_MISSING",
        "The Cloudflare account or installation identifier is unavailable.",
      );
    const body = (await c.req.json().catch(() => null)) as {
      token?: unknown;
      mode?: unknown;
      bucketName?: unknown;
    } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const mode = body?.mode === "attach" ? "attach" : "create";
    if (!validCloudflareTokenLength(token))
      throw new AppError(
        422,
        "R2_TOKEN_INVALID",
        "Enter a valid temporary Cloudflare R2 token.",
      );
    const deterministicName = await deterministicR2BucketName(
      c.env.APP_INSTALLATION_ID,
      operation.pluginId,
    );
    const requestedName =
      mode === "attach" && typeof body?.bucketName === "string"
        ? body.bucketName.trim()
        : deterministicName;
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/u.test(requestedName))
      throw new AppError(
        422,
        "R2_BUCKET_NAME_INVALID",
        "The R2 bucket name is invalid.",
      );
    const db = c.get("db");
    const existing = await db.first<{
      externalName: string;
      operationId: string;
      status: string;
    }>(
      `SELECT external_name AS "externalName",
              created_by_operation_id AS "operationId", status
         FROM plugin_runtime_resources
        WHERE plugin_id = ? AND binding_name = 'STORAGE'`,
      [operation.pluginId],
    );
    if (existing && existing.externalName !== requestedName)
      throw new AppError(
        409,
        "R2_BUCKET_CONFLICT",
        "A different preserved bucket is already registered for this plugin.",
      );
    const now = dbTime(db);
    const reserved = await db.execute(
      `INSERT INTO plugin_runtime_resources(
         plugin_id, resource_type, binding_name, external_name, status,
         created_by_operation_id, created_at, updated_at
       ) VALUES (?, 'r2', 'STORAGE', ?, 'provisioning', ?, ?, ?)
       ON CONFLICT(plugin_id, binding_name) DO UPDATE SET
         status = 'provisioning', created_by_operation_id = excluded.created_by_operation_id,
         updated_at = excluded.updated_at, last_error_code = NULL
       WHERE plugin_runtime_resources.external_name = excluded.external_name`,
      [operation.pluginId, requestedName, operation.operationId, now, now],
    );
    if (!reserved.rowsAffected)
      throw new AppError(
        409,
        "R2_BUCKET_CONFLICT",
        "The requested R2 bucket conflicts with a registered resource.",
      );
    try {
      const provisionMode =
        existing &&
        ["preserving", "preserved", "missing"].includes(existing.status)
          ? "attach"
          : mode;
      const result = await provisionR2Bucket(
        token,
        c.env.CF_ACCOUNT_ID,
        requestedName,
        provisionMode,
      );
      if (provisionMode === "create" && !result.created && !existing)
        throw new R2ProvisioningError("bucket_conflict");
      const verifiedAt = dbTime(db);
      await db.atomic([
        {
          sql: `UPDATE plugin_runtime_resources
                   SET status = 'ready', last_verified_at = ?, last_error_code = NULL,
                       updated_at = ?, preserved_at = NULL
                 WHERE plugin_id = ? AND binding_name = 'STORAGE'
                   AND external_name = ?`,
          params: [verifiedAt, verifiedAt, operation.pluginId, requestedName],
        },
        {
          sql: `UPDATE plugin_operations SET state = 'migrating', lock_expires_at = ?
                 WHERE operation_id = ? AND state = 'provisioning'`,
          params: [dbTime(db, Date.now() + 300_000), operation.operationId],
        },
      ]);
      await audit(
        c,
        "core.plugin.runtime_resource_ready",
        "core.plugin",
        operation.pluginId,
        { operationId: operation.operationId, resourceType: "r2" },
      );
      return c.json({
        operationId: operation.operationId,
        state: "migrating",
        resource: { type: "r2", binding: "STORAGE" },
      });
    } catch (error) {
      const code =
        error instanceof R2ProvisioningError ? error.code : "unavailable";
      await db.atomic([
        {
          sql: `UPDATE plugin_runtime_resources
                   SET status = ?, last_error_code = ?, updated_at = ?
                 WHERE plugin_id = ? AND binding_name = 'STORAGE'`,
          params: [
            code === "bucket_missing" ? "missing" : "error",
            code,
            dbTime(db),
            operation.pluginId,
          ],
        },
        {
          sql: `UPDATE plugin_operations SET state = 'failed', last_error = ?
                 WHERE operation_id = ?`,
          params: [
            JSON.stringify({
              from: "provisioning",
              detail: `r2_${code}`,
              requestId: c.get("requestId"),
              failedAt: Date.now(),
            }),
            operation.operationId,
          ],
        },
        {
          sql: `UPDATE installer_lock SET operation_id = NULL, acquired_at = NULL,
                       expires_at = NULL
                 WHERE id = 'global' AND operation_id = ?`,
          params: [operation.operationId],
        },
      ]);
      const mapped =
        code === "too_broad"
          ? [
              422,
              "R2_TOKEN_TOO_BROAD",
              "Use a token limited to Workers R2 Storage Write.",
            ]
          : code === "invalid"
            ? [
                422,
                "R2_TOKEN_INVALID",
                "The temporary R2 token is invalid or belongs to another account.",
              ]
            : code === "not_entitled"
              ? [
                  409,
                  "R2_NOT_ENTITLED",
                  "Activate R2 on this Cloudflare account before installing the plugin.",
                ]
              : code === "bucket_missing"
                ? [
                    404,
                    "R2_BUCKET_MISSING",
                    "The selected R2 bucket does not exist.",
                  ]
                : code === "bucket_conflict"
                  ? [
                      409,
                      "R2_BUCKET_CONFLICT",
                      "The deterministic bucket already exists outside this Nexus installation.",
                    ]
                  : [
                      503,
                      "R2_UNAVAILABLE",
                      "Cloudflare could not provision the private R2 bucket.",
                    ];
      throw new AppError(
        mapped[0] as 404 | 409 | 422 | 503,
        mapped[1] as string,
        mapped[2] as string,
      );
    }
  },
);

installerRoutes.post("/plugin-operations/:operationId/advance", async (c) => {
  const operation = await getOperation(c);
  requirePluginOperationPermission(c, operation.type);
  const db = c.get("db");
  const recordFailure = async (from: string, detail: string) => {
    await db.atomic([
      {
        sql: "UPDATE plugin_operations SET state = 'failed', last_error = ? WHERE operation_id = ?",
        params: [
          JSON.stringify({
            from,
            detail: detail.slice(0, 500),
            requestId: c.get("requestId"),
            failedAt: Date.now(),
          }),
          operation.operationId,
        ],
      },
      {
        sql: `UPDATE plugin_runtime_resources
                 SET status = 'preserved', preserved_at = ?, updated_at = ?
               WHERE plugin_id = ? AND binding_name = 'STORAGE'
                 AND created_by_operation_id = ? AND status = 'ready'`,
        params: [
          dbTime(db),
          dbTime(db),
          operation.pluginId,
          operation.operationId,
        ],
      },
      {
        sql: "UPDATE installer_lock SET operation_id = NULL, acquired_at = NULL, expires_at = NULL WHERE id = 'global' AND operation_id = ?",
        params: [operation.operationId],
      },
    ]);
    await audit(
      c,
      "core.plugin.installation_failed",
      "core.plugin",
      operation.pluginId,
      { operationId: operation.operationId, stage: from },
    );
  };
  const fail = async (from: string, error: unknown) => {
    await recordFailure(
      from,
      error instanceof Error ? error.message : "unknown",
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
      validatePackagePolicy(c, parts.manifest);
      verifyPortablePackageBoundary(
        c.env,
        parts,
        await runtimeBoundaryValues(c, operation.pluginId),
      );
      await db.atomic(
        archivePackageStatements(operation.operationId, parts, dbTime(db)),
      );
      const resource = await db.first<{ status: string }>(
        `SELECT status FROM plugin_runtime_resources
          WHERE plugin_id = ? AND binding_name = 'STORAGE'`,
        [operation.pluginId],
      );
      const nextState =
        parts.manifest.runtimeBindings?.includes("r2") &&
        resource?.status !== "ready"
          ? "provisioning"
          : "migrating";
      await db.execute(
        "UPDATE plugin_operations SET state = ?, lock_expires_at = ? WHERE operation_id = ?",
        [nextState, dbTime(db, Date.now() + 300_000), operation.operationId],
      );
      return c.json({ operationId: operation.operationId, state: nextState });
    }
    if (operation.state === "provisioning")
      throw new AppError(
        409,
        "PLUGIN_RUNTIME_R2_REQUIRED",
        "Provision the private R2 bucket before advancing this operation.",
      );
    if (operation.state === "migrating") {
      const parts = await readPackage(c);
      await verifyPackage(operation, parts);
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
          [operation.pluginId, c.env.DATABASE_PROVIDER, migration.migrationId],
        );
        if (existing && existing.sha256 !== digest)
          throw new Error(`Migration hash mismatch: ${migration.migrationId}`);
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
        "UPDATE plugin_operations SET state = 'deploying', lock_expires_at = ? WHERE operation_id = ?",
        [dbTime(db, Date.now() + 300_000), operation.operationId],
      );
      return c.json({
        operationId: operation.operationId,
        state: "deploying",
      });
    }
    if (operation.state === "deploying") {
      const parts = await readPackage(c);
      await verifyPackage(operation, parts);
      const resource = parts.manifest.runtimeBindings?.includes("r2")
        ? await db.first<{ externalName: string; status: string }>(
            `SELECT external_name AS "externalName", status
               FROM plugin_runtime_resources
              WHERE plugin_id = ? AND binding_name = 'STORAGE'`,
            [operation.pluginId],
          )
        : null;
      if (
        parts.manifest.runtimeBindings?.includes("r2") &&
        resource?.status !== "ready"
      )
        throw new Error("PLUGIN_RUNTIME_R2_REQUIRED");
      await uploadPluginWorker(
        c.env,
        workerName(operation.pluginId),
        parts.worker,
        parts.manifest,
        resource ? { STORAGE: resource.externalName } : {},
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
            "X-Plugin-Installer-Context": encodedContextHeader({
              pluginId: operation.pluginId,
              operationId: operation.operationId,
              requestId: c.get("requestId"),
            } satisfies PluginInstallerContext),
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
            sql: `DELETE FROM plugin_package_chunks
                   WHERE operation_id IN (
                     SELECT operation_id FROM plugin_operations
                      WHERE plugin_id = ? AND operation_id <> ?
                   )`,
            params: [operation.pluginId, operation.operationId],
          },
          {
            sql: "UPDATE plugin_operations SET state = 'installed', finished_at = ? WHERE operation_id = ?",
            params: [now, operation.operationId],
          },
          ...(parts.manifest.runtimeBindings?.includes("r2")
            ? []
            : [
                {
                  sql: `UPDATE plugin_runtime_resources
                           SET status = 'preserved', preserved_at = ?, updated_at = ?
                         WHERE plugin_id = ? AND binding_name = 'STORAGE'
                           AND status = 'ready'`,
                  params: [now, now, operation.pluginId],
                },
              ]),
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
    if (error instanceof AppError) {
      if (error.code === "PLUGIN_PACKAGE_HASH_MISMATCH")
        await recordFailure(operation.state, error.message);
      throw error;
    }
    return fail(operation.state, error);
  }
});

installerRoutes.get(
  "/plugins/:pluginId/package",
  requirePermission("core.plugin.export"),
  async (c) => {
    const pluginId = c.req.param("pluginId");
    const plugin = await c
      .get("db")
      .first<{ installedVersion: string | null; status: string }>(
        `SELECT installed_version AS "installedVersion", status
           FROM plugins WHERE id = ?`,
        [pluginId],
      );
    if (!plugin)
      throw new AppError(404, "PLUGIN_NOT_FOUND", "Plugin not found.");
    if (plugin.status !== "installed" || !plugin.installedVersion)
      throw new AppError(
        409,
        "PLUGIN_PACKAGE_EXPORT_NOT_INSTALLED",
        "Only an installed plugin can be downloaded.",
      );
    const operation = await c.get("db").first<{
      operationId: string;
      manifestSha256: string;
      workerSha256: string;
      d1MigrationsSha256: string;
      postgresMigrationsSha256: string;
    }>(
      `SELECT operation_id AS "operationId", manifest_sha256 AS "manifestSha256",
              worker_sha256 AS "workerSha256", d1_migrations_sha256 AS "d1MigrationsSha256",
              postgres_migrations_sha256 AS "postgresMigrationsSha256"
         FROM plugin_operations
        WHERE plugin_id = ? AND target_version = ? AND state = 'installed'
        ORDER BY finished_at DESC`,
      [pluginId, plugin.installedVersion],
    );
    if (!operation)
      throw new AppError(
        409,
        "PLUGIN_PACKAGE_EXPORT_UNAVAILABLE",
        "Update or reinstall this plugin once to create a portable package.",
      );
    try {
      const parts = await loadPortablePackage(
        c.get("db"),
        operation.operationId,
      );
      await verifyPortablePackage(parts, {
        pluginId,
        version: plugin.installedVersion,
        manifest: operation.manifestSha256,
        worker: operation.workerSha256,
        d1: operation.d1MigrationsSha256,
        postgres: operation.postgresMigrationsSha256,
      });
      const zip = portablePackageZip(parts);
      await audit(
        c,
        "core.plugin.package_downloaded",
        "core.plugin",
        pluginId,
        {
          version: plugin.installedVersion,
          bytes: zip.byteLength,
        },
      );
      const responseBody = new Uint8Array(zip.byteLength);
      responseBody.set(zip);
      return new Response(responseBody.buffer, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename="${pluginId}-${plugin.installedVersion}.plugin.zip"`,
          "Content-Length": String(zip.byteLength),
          "Content-Type": "application/zip",
        },
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        409,
        "PLUGIN_PACKAGE_EXPORT_UNAVAILABLE",
        "The portable package is unavailable or failed integrity verification. Update or reinstall the plugin.",
      );
    }
  },
);

installerRoutes.post(
  "/plugins/:pluginId/package",
  requirePermission("core.plugin.export"),
  async (c) => {
    const pluginId = c.req.param("pluginId");
    const plugin = await c
      .get("db")
      .first<{ installedVersion: string | null; status: string }>(
        `SELECT installed_version AS "installedVersion", status
           FROM plugins WHERE id = ?`,
        [pluginId],
      );
    if (!plugin)
      throw new AppError(404, "PLUGIN_NOT_FOUND", "Plugin not found.");
    if (plugin.status !== "installed" || !plugin.installedVersion)
      throw new AppError(
        409,
        "PLUGIN_PACKAGE_EXPORT_NOT_INSTALLED",
        "Only an installed plugin can have its portable package restored.",
      );

    const operation = await c.get("db").first<Operation>(
      `SELECT operation_id AS "operationId", plugin_id AS "pluginId", type, target_version AS "targetVersion", state,
              manifest_sha256 AS "manifestSha256", worker_sha256 AS "workerSha256",
              d1_migrations_sha256 AS "d1MigrationsSha256",
              postgres_migrations_sha256 AS "postgresMigrationsSha256", last_error AS "lastError"
         FROM plugin_operations
        WHERE plugin_id = ? AND target_version = ? AND state = 'installed'
        ORDER BY finished_at DESC`,
      [pluginId, plugin.installedVersion],
    );
    if (!operation)
      throw new AppError(
        409,
        "PLUGIN_PACKAGE_EXPORT_UNAVAILABLE",
        "The original installation record is unavailable.",
      );

    const parts = await readPackage(c);
    if (
      parts.manifest.id !== pluginId ||
      parts.manifest.version !== plugin.installedVersion
    )
      throw new AppError(
        409,
        "PLUGIN_PACKAGE_ARCHIVE_MISMATCH",
        "Select the original package for this installed plugin and version.",
      );
    try {
      validatePackagePolicy(c, parts.manifest);
      if (!parts.worker) throw new Error("worker.mjs is required.");
      const d1Ids = Object.keys(parts.d1Migrations).sort();
      const postgresIds = Object.keys(parts.postgresMigrations).sort();
      if (stableJson(d1Ids) !== stableJson(postgresIds))
        throw new Error("Plugin migrations are not paired.");
      migrationStatements(parts.d1Migrations, parts.manifest.tablePrefix);
      migrationStatements(parts.postgresMigrations, parts.manifest.tablePrefix);
      verifyPortablePackageBoundary(
        c.env,
        parts,
        await runtimeBoundaryValues(c, pluginId),
      );
      await verifyPackage(operation, parts);
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === "PLUGIN_PACKAGE_HASH_MISMATCH")
          throw new AppError(
            409,
            "PLUGIN_PACKAGE_ARCHIVE_MISMATCH",
            "The selected file is not the exact package used for this installation.",
          );
        throw error;
      }
      throw new AppError(
        422,
        "PLUGIN_PACKAGE_INVALID",
        "The selected plugin package is invalid.",
      );
    }

    await c
      .get("db")
      .atomic(
        archivePackageStatements(
          operation.operationId,
          parts,
          dbTime(c.get("db")),
        ),
      );
    await audit(c, "core.plugin.package_archived", "core.plugin", pluginId, {
      version: plugin.installedVersion,
      bytes: parts.rawBytes,
      source: "verified_original_package",
    });
    return c.body(null, 204);
  },
);

installerRoutes.delete(
  "/plugins/:pluginId",
  requirePermission("core.plugin.delete"),
  async (c) => {
    const pluginId = c.req.param("pluginId");
    const plugin = await c
      .get("db")
      .first<{ workerName: string; status: string }>(
        `SELECT worker_name AS "workerName", status FROM plugins WHERE id = ?`,
        [pluginId],
      );
    if (!plugin)
      throw new AppError(404, "PLUGIN_NOT_FOUND", "Plugin not found.");
    if (plugin.status === "uninstalled") {
      const results = await c.get("db").atomic([
        {
          sql: `DELETE FROM plugin_package_chunks
                 WHERE operation_id IN (
                   SELECT operation_id FROM plugin_operations WHERE plugin_id = ?
                 )`,
          params: [pluginId],
        },
        {
          sql: "DELETE FROM plugins WHERE id = ? AND status = 'uninstalled'",
          params: [pluginId],
        },
      ]);
      if (!results[1]?.rowsAffected)
        throw new AppError(
          409,
          "PLUGIN_STATE_CONFLICT",
          "The plugin state changed before its record could be deleted.",
        );
      await audit(c, "core.plugin.record_deleted", "core.plugin", pluginId, {
        tablesPreserved: true,
        migrationsPreserved: true,
        operationHistoryPreserved: true,
      });
      return c.body(null, 204);
    }
    if (plugin.status !== "installed")
      throw new AppError(
        409,
        "PLUGIN_STATE_CONFLICT",
        `The plugin cannot be removed while its status is ${plugin.status}.`,
      );
    const uninstallingAt = dbTime(c.get("db"));
    await c.get("db").atomic([
      {
        sql: "UPDATE plugins SET status = 'uninstalling', updated_at = ? WHERE id = ?",
        params: [uninstallingAt, pluginId],
      },
      {
        sql: `UPDATE plugin_runtime_resources
                 SET status = 'preserving', updated_at = ?
               WHERE plugin_id = ? AND binding_name = 'STORAGE'
                 AND status IN ('ready','error')`,
        params: [uninstallingAt, pluginId],
      },
    ]);
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
        {
          sql: `UPDATE plugin_runtime_resources
                   SET status = 'preserved', preserved_at = ?, updated_at = ?
                 WHERE plugin_id = ? AND binding_name = 'STORAGE'`,
          params: [dbTime(c.get("db")), dbTime(c.get("db")), pluginId],
        },
      ],
      {
        eventType: "core.plugin.uninstalled",
        resourceType: "core.plugin",
        resourceId: pluginId,
        data: { tablesPreserved: true, objectStoragePreserved: true },
      },
    );
    await audit(c, "core.plugin.uninstalled", "core.plugin", pluginId, {
      objectStoragePreserved: true,
    });
    return c.body(null, 204);
  },
);
