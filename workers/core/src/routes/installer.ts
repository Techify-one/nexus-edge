import { Hono, type Context } from "hono";
import { createId, type PluginInstallerContext } from "@app/core-contract";
import { sha256, stableJson } from "@app/webhook-contract";
import type { SqlStatement, SqlValue } from "@app/database";
import semver from "semver";
import type { HonoEnv } from "../env.js";
import {
  attachPluginR2Binding,
  attachPluginResourceBinding,
  configurePluginQueueConsumers,
  deletePluginSecret,
  deletePluginWorker,
  configurePluginWorkerSchedules,
  configurePluginRuntimeCredential,
  hardenPluginWorker,
  mergeCoreServiceBinding,
  PluginRuntimeCredentialError,
  pluginSecretConfigured,
  pluginRuntimeCredentialStatus,
  PluginResourceProvisioningError,
  provisionPluginResource,
  provisionR2Bucket,
  putPluginSecret,
  removePluginQueueConsumers,
  removeCoreServiceBinding,
  R2ProvisioningError,
  uploadPluginWorker,
  type PluginRuntimeResource,
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
import {
  decodePackageFile,
  MAX_PLUGIN_PACKAGE_BYTES,
  packageFilesDigest,
  parsePluginArchive,
} from "../installer/package-v2.js";
import { AppError, noStore } from "../lib/http.js";
import { canPermission } from "../lib/ability.js";
import { dbTime, numberTime, parseJson } from "../lib/values.js";
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
  assetsSha256: string | null;
  sourceReleaseId: string | null;
  lastError: string | null;
};
type PackageParts = {
  manifest: PluginManifest;
  worker: string;
  d1Migrations: MigrationSet;
  postgresMigrations: MigrationSet;
  manifestSource?: string;
  files: Record<string, string>;
  archiveSha256?: string | undefined;
  sourceReleaseId: string | undefined;
  rawBytes: number;
};

type ResourceRow = {
  logicalName: string;
  type: PluginRuntimeResource["type"];
  binding: string;
  required: number | boolean;
  externalId: string | null;
  externalName: string | null;
  status: string;
  configuration: unknown;
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
const installationNamespace = async (
  installationId: string,
): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(installationId),
    ),
  );
  return [...digest]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const pluginWorkerName = async (
  installationId: string,
  pluginId: string,
): Promise<string> =>
  `app-${await installationNamespace(installationId)}-plugin-${pluginId.replaceAll("_", "-")}`;

const operationWorkerName = async (
  c: Context<HonoEnv>,
  operation: Operation,
): Promise<string> => {
  if (operation.type === "update") {
    const existing = await c.get("db").first<{
      workerName: string;
      status: string;
    }>(`SELECT worker_name AS "workerName", status FROM plugins WHERE id = ?`, [operation.pluginId]);
    if (
      existing?.status !== "installed" ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(existing.workerName)
    )
      throw new Error("PLUGIN_WORKER_TARGET_INVALID");
    // Preserve legacy targets during updates so their Worker secrets and
    // bindings survive without a disruptive migration.
    return existing.workerName;
  }
  return pluginWorkerName(c.env.APP_INSTALLATION_ID, operation.pluginId);
};
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
  const plugin = await c
    .get("db")
    .first<{ workerName: string; status: string; manifest: unknown }>(
      `SELECT worker_name AS "workerName", status, manifest_json AS manifest
         FROM plugins WHERE id = ?`,
      [pluginId],
    );
  if (!plugin || plugin.status !== "installed")
    throw new AppError(404, "PLUGIN_NOT_INSTALLED", "Plugin is not installed.");
  const parsedManifest = pluginManifestSchema.safeParse(
    parseJson<unknown>(plugin.manifest, null),
  );
  const declaredSecret = parsedManifest.success
    ? parsedManifest.data.secrets?.find((secret) => secret.name === secretName)
    : undefined;
  const legacyPolicy = allowedRuntimeSecrets.get(pluginId);
  const requiredPermission =
    declaredSecret?.permission ??
    (legacyPolicy?.names.has(secretName)
      ? `${pluginId}.${legacyPolicy.permissionResource}.${access}`
      : undefined);
  if (!requiredPermission)
    throw new AppError(404, "PLUGIN_SECRET_NOT_FOUND", "Secret not found.");
  if (!canPermission(c.get("ability"), requiredPermission))
    throw new AppError(403, "FORBIDDEN", "Permission denied.");
  return { pluginId, secretName, workerName: plugin.workerName };
};
const bulkStatements = (
  prefix: string,
  rows: SqlValue[][],
  suffix = "",
): SqlStatement[] => {
  if (!rows.length) return [];
  const columns = rows[0]!.length;
  if (!columns || rows.some((row) => row.length !== columns))
    throw new Error("Bulk SQL rows must use one stable shape.");
  const rowsPerStatement = Math.max(1, Math.floor(90 / columns));
  const statements: SqlStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const batch = rows.slice(offset, offset + rowsPerStatement);
    statements.push({
      sql: `${prefix} ${batch
        .map(() => `(${Array.from({ length: columns }, () => "?").join(", ")})`)
        .join(", ")} ${suffix}`.trim(),
      params: batch.flat(),
    });
  }
  return statements;
};

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
  const prefix = await installationNamespace(installationId);
  const pluginSlug = pluginId.replaceAll("_", "-").slice(0, 43);
  return `nexus-${prefix}-${pluginSlug}`;
};

const deterministicResourceName = async (
  installationId: string,
  pluginId: string,
  logicalName: string,
): Promise<string> => {
  const prefix = await installationNamespace(installationId);
  const pluginSlug = pluginId.replaceAll("_", "-");
  const resourceSlug = logicalName.replaceAll("_", "-");
  return `nexus-${prefix}-${pluginSlug}-${resourceSlug}`.slice(0, 63);
};

const readResourceRows = async (
  c: Context<HonoEnv>,
  pluginId: string,
  options: { includePreserved?: boolean } = {},
): Promise<PluginRuntimeResource[]> => {
  const rows = await c.get("db").query<ResourceRow>(
    `SELECT logical_name AS "logicalName", resource_type AS type,
            binding_name AS binding, required, external_id AS "externalId",
            external_name AS "externalName", status,
            declaration_json AS configuration
       FROM plugin_resources_v2
      WHERE plugin_id = ?${options.includePreserved ? "" : " AND status <> 'preserved'"}
      ORDER BY logical_name`,
    [pluginId],
  );
  return rows.map((row) => {
    const declaration = parseJson<{
      configuration?: Record<string, unknown>;
    }>(row.configuration, {});
    return {
      logicalName: row.logicalName,
      type: row.type,
      binding: row.binding,
      required: Boolean(row.required),
      externalId: row.externalId,
      externalName: row.externalName,
      configuration: declaration.configuration ?? {},
    };
  });
};

const reconcileResourcePlan = async (
  c: Context<HonoEnv>,
  operation: Operation,
  manifest: PluginManifest,
): Promise<boolean> => {
  const declarations = manifest.resources ?? [];
  const db = c.get("db");
  const now = dbTime(db);
  const declaredNames = new Set(declarations.map((resource) => resource.name));
  const existing = await db.query<ResourceRow>(
    `SELECT logical_name AS "logicalName", resource_type AS type,
            binding_name AS binding, required, external_id AS "externalId",
            external_name AS "externalName", status,
            declaration_json AS configuration
       FROM plugin_resources_v2 WHERE plugin_id = ?`,
    [operation.pluginId],
  );
  const removedDurableObject = existing.find(
    (resource) =>
      resource.type === "durable_object" &&
      !declaredNames.has(resource.logicalName),
  );
  if (removedDurableObject)
    throw new AppError(
      409,
      "PLUGIN_DURABLE_OBJECT_LIFECYCLE_CHANGE",
      "Removing a Durable Object class requires an explicit data lifecycle procedure.",
    );
  const byName = new Map(
    existing.map((resource) => [resource.logicalName, resource]),
  );
  const ownerWorkerName = await operationWorkerName(c, operation);
  const statements: SqlStatement[] = existing
    .filter((resource) => !declaredNames.has(resource.logicalName))
    .map((resource) => ({
      sql: `UPDATE plugin_resources_v2
               SET status = 'preserved', preserved_at = ?, updated_at = ?
             WHERE plugin_id = ? AND logical_name = ?`,
      params: [now, now, operation.pluginId, resource.logicalName],
    }));
  let blocksInstallation = false;
  for (const declaration of declarations) {
    const previous = byName.get(declaration.name);
    if (
      previous &&
      (previous.type !== declaration.type ||
        previous.binding !== declaration.binding)
    )
      throw new AppError(
        409,
        "PLUGIN_RESOURCE_IDENTITY_CHANGED",
        `Resource ${declaration.name} cannot change type or binding during an update.`,
      );
    if (
      previous?.type === "durable_object" &&
      declaration.type === "durable_object"
    ) {
      const previousDeclaration = parseJson<{
        configuration?: { className?: string };
      }>(previous.configuration, {});
      if (
        previousDeclaration.configuration?.className &&
        previousDeclaration.configuration.className !==
          declaration.configuration.className
      )
        throw new AppError(
          409,
          "PLUGIN_DURABLE_OBJECT_LIFECYCLE_CHANGE",
          "Renaming a Durable Object class requires an explicit data lifecycle procedure.",
        );
    }
    const external = ["r2", "kv", "queue"].includes(declaration.type);
    const status =
      previous?.externalName && ["ready", "preserved"].includes(previous.status)
        ? "ready"
        : external
          ? "pending"
          : "ready";
    if (external && declaration.required && status !== "ready")
      blocksInstallation = true;
    statements.push({
      sql: `INSERT INTO plugin_resources_v2(
              plugin_id, logical_name, resource_type, capability_version,
              binding_name, external_id, external_name, owner_worker_name,
              required, status, retention_policy, declaration_json,
              created_at, updated_at, preserved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(plugin_id, logical_name) DO UPDATE SET
              capability_version=excluded.capability_version,
              required=excluded.required, status=excluded.status,
              retention_policy=excluded.retention_policy,
              declaration_json=excluded.declaration_json,
              owner_worker_name=excluded.owner_worker_name,
              updated_at=excluded.updated_at, preserved_at=NULL,
              last_error_code=NULL`,
      params: [
        operation.pluginId,
        declaration.name,
        declaration.type,
        declaration.capabilityVersion,
        declaration.binding,
        previous?.externalId ?? null,
        previous?.externalName ?? null,
        ownerWorkerName,
        declaration.required,
        status,
        declaration.retention,
        JSON.stringify(declaration),
        now,
        now,
      ],
    });
  }
  await db.atomic(statements);
  return blocksInstallation;
};

const restorePreviousPluginWorker = async (
  c: Context<HonoEnv>,
  operation: Operation,
): Promise<void> => {
  if (operation.type !== "update") return;
  const previous = await c.get("db").first<{ operationId: string }>(
    `SELECT operation_id AS "operationId" FROM plugin_operations
      WHERE plugin_id = ? AND state = 'installed' AND operation_id <> ?
      ORDER BY finished_at DESC LIMIT 1`,
    [operation.pluginId, operation.operationId],
  );
  if (!previous) throw new Error("PLUGIN_UPDATE_ROLLBACK_PACKAGE_MISSING");
  const archived = await loadPortablePackage(c.get("db"), previous.operationId);
  const workerName = await operationWorkerName(c, operation);
  const ledger = await readResourceRows(c, operation.pluginId, {
    includePreserved: true,
  });
  const ledgerByName = new Map(
    ledger.map((resource) => [resource.logicalName, resource]),
  );
  const resources = (archived.manifest.resources ?? []).map((declaration) => {
    const recorded = ledgerByName.get(declaration.name);
    return {
      logicalName: declaration.name,
      type: declaration.type,
      binding: declaration.binding,
      required: declaration.required,
      externalId: recorded?.externalId ?? null,
      externalName: recorded?.externalName ?? null,
      configuration: declaration.configuration,
    } satisfies PluginRuntimeResource;
  });
  const legacyResource = archived.manifest.runtimeBindings?.includes("r2")
    ? await c.get("db").first<{ externalName: string; status: string }>(
        `SELECT external_name AS "externalName", status
           FROM plugin_runtime_resources
          WHERE plugin_id = ? AND binding_name = 'STORAGE'`,
        [operation.pluginId],
      )
    : null;
  await uploadPluginWorker(
    c.env,
    workerName,
    archived.worker,
    archived.manifest,
    [
      ...resources,
      ...(legacyResource?.externalName
        ? [
            {
              logicalName: "storage",
              type: "r2" as const,
              binding: "STORAGE",
              required: true,
              externalId: null,
              externalName: legacyResource.externalName,
              configuration: {},
            },
          ]
        : []),
    ],
    archived.files ?? {},
  );
  if (archived.manifest.packageFormat === 2) {
    await configurePluginQueueConsumers(c.env, workerName, resources);
    await configurePluginWorkerSchedules(c.env, workerName, resources);
  }
  await hardenPluginWorker(c.env, workerName);
  await mergeCoreServiceBinding(
    c.env,
    bindingName(operation.pluginId),
    workerName,
  );
  const restoredAt = dbTime(c.get("db"));
  await c.get("db").atomic([
    {
      sql: `UPDATE plugin_resources_v2
               SET status = 'preserved', preserved_at = ?, updated_at = ?
             WHERE plugin_id = ?`,
      params: [restoredAt, restoredAt, operation.pluginId],
    },
    ...(archived.manifest.resources ?? []).map((declaration) => {
      const recorded = ledgerByName.get(declaration.name);
      const external = ["r2", "kv", "queue"].includes(declaration.type);
      const externalReady =
        declaration.type === "r2"
          ? Boolean(recorded?.externalName)
          : Boolean(recorded?.externalId && recorded.externalName);
      return {
        sql: `UPDATE plugin_resources_v2
                 SET resource_type = ?, capability_version = ?,
                     binding_name = ?, required = ?, status = ?,
                     retention_policy = ?, declaration_json = ?,
                     preserved_at = NULL, updated_at = ?
               WHERE plugin_id = ? AND logical_name = ?`,
        params: [
          declaration.type,
          declaration.capabilityVersion,
          declaration.binding,
          declaration.required,
          external && !externalReady ? "pending" : "ready",
          declaration.retention,
          JSON.stringify(declaration),
          restoredAt,
          operation.pluginId,
          declaration.name,
        ],
      };
    }),
  ]);
};

const hasR2Capability = (manifest: PluginManifest): boolean =>
  Boolean(
    manifest.runtimeBindings?.includes("r2") ||
    manifest.optionalRuntimeBindings?.includes("r2") ||
    manifest.resources?.some((resource) => resource.type === "r2"),
  );

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
  if (length > MAX_PLUGIN_PACKAGE_BYTES + 1024 * 1024)
    throw new AppError(
      413,
      "PLUGIN_TOO_LARGE",
      "The package exceeds the raw size limit.",
    );
  const form = await c.req.formData();
  const sourceReleaseValue = String(form.get("sourceReleaseId") ?? "").trim();
  const sourceReleaseId = /^rel_[A-Za-z0-9_-]{8,100}$/u.test(sourceReleaseValue)
    ? sourceReleaseValue
    : undefined;
  const packageValue = form.get("package");
  if (packageValue instanceof File) {
    if (packageValue.size > MAX_PLUGIN_PACKAGE_BYTES)
      throw new AppError(
        413,
        "PLUGIN_TOO_LARGE",
        "The package exceeds the raw size limit.",
      );
    try {
      return {
        ...(await parsePluginArchive(
          new Uint8Array(await packageValue.arrayBuffer()),
        )),
        sourceReleaseId,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid";
      throw new AppError(
        detail.includes("SIZE") || detail.includes("EXPANSION") ? 413 : 422,
        detail.startsWith("PLUGIN_")
          ? detail.split(":", 1)[0]!
          : "PLUGIN_PACKAGE_INVALID",
        "The plugin package is invalid or failed integrity validation.",
      );
    }
  }
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
  if (rawBytes > MAX_PLUGIN_PACKAGE_BYTES)
    throw new AppError(
      413,
      "PLUGIN_TOO_LARGE",
      "The package exceeds the raw size limit.",
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
    manifestSource: manifestText,
    worker,
    d1Migrations,
    postgresMigrations,
    files: {},
    sourceReleaseId,
    rawBytes,
  };
}

const hashes = async (parts: PackageParts) => ({
  manifest: await sha256(stableJson(parts.manifest)),
  worker: await sha256(parts.worker),
  d1: await sha256(stableJson(parts.d1Migrations)),
  postgres: await sha256(stableJson(parts.postgresMigrations)),
  assets: await packageFilesDigest(parts.files),
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
  if (!manifest.databaseDialects.includes(c.env.DATABASE_PROVIDER))
    throw new AppError(
      409,
      "PLUGIN_DATABASE_PROVIDER_UNSUPPORTED",
      `This plugin does not support the active ${c.env.DATABASE_PROVIDER} database provider.`,
    );
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
          : error.code === "host_api_unsupported"
            ? [
                422,
                "PLUGIN_HOST_API_UNSUPPORTED",
                "The plugin host API version is not supported by this Core.",
              ]
            : error.code === "core_api_unsupported"
              ? [
                  422,
                  "PLUGIN_CORE_API_UNSUPPORTED",
                  "The plugin Core API version is not supported by this Core.",
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

type DependencyLock = {
  pluginId: string;
  version: string;
  marketplaceId: string | null;
  releaseId: string | null;
};

const resolveDependencies = async (
  c: Context<HonoEnv>,
  manifest: PluginManifest,
): Promise<DependencyLock[]> => {
  const locks: DependencyLock[] = [];
  for (const dependency of manifest.dependencies ?? []) {
    if (dependency.pluginId === manifest.id)
      throw new AppError(
        409,
        "PLUGIN_DEPENDENCY_CYCLE",
        "A plugin cannot depend on itself.",
      );
    const installed = await c.get("db").first<{
      version: string;
      marketplaceId: string | null;
      releaseId: string | null;
    }>(
      `SELECT installed_version AS version, marketplace_id AS "marketplaceId",
              release_id AS "releaseId"
         FROM plugins WHERE id = ? AND status = 'installed'`,
      [dependency.pluginId],
    );
    if (!installed) {
      if (dependency.optional) continue;
      throw new AppError(
        409,
        "PLUGIN_DEPENDENCY_MISSING",
        `Install dependency ${dependency.pluginId} (${dependency.version}) first.`,
      );
    }
    if (!semver.satisfies(installed.version, dependency.version))
      throw new AppError(
        409,
        "PLUGIN_DEPENDENCY_VERSION_UNSUPPORTED",
        `Dependency ${dependency.pluginId} must satisfy ${dependency.version}.`,
      );
    locks.push({ pluginId: dependency.pluginId, ...installed });
  }
  const installedRows = await c.get("db").query<{
    id: string;
    manifest: unknown;
  }>("SELECT id, manifest_json AS manifest FROM plugins WHERE status = 'installed'");
  const graph = new Map<string, string[]>();
  for (const row of installedRows) {
    const parsed = pluginManifestSchema.safeParse(
      parseJson<unknown>(row.manifest, null),
    );
    graph.set(
      row.id,
      parsed.success
        ? (parsed.data.dependencies ?? []).map(
            (dependency) => dependency.pluginId,
          )
        : [],
    );
  }
  graph.set(
    manifest.id,
    (manifest.dependencies ?? []).map((dependency) => dependency.pluginId),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (pluginId: string): boolean => {
    if (visiting.has(pluginId)) return true;
    if (visited.has(pluginId)) return false;
    visiting.add(pluginId);
    for (const dependency of graph.get(pluginId) ?? [])
      if (graph.has(dependency) && visit(dependency)) return true;
    visiting.delete(pluginId);
    visited.add(pluginId);
    return false;
  };
  if (visit(manifest.id))
    throw new AppError(
      409,
      "PLUGIN_DEPENDENCY_CYCLE",
      "The plugin dependency graph contains a cycle.",
    );
  return locks;
};

async function getOperation(c: {
  get(name: "db"): HonoEnv["Variables"]["db"];
  req: { param(name: string): string };
}): Promise<Operation> {
  const operation = await c.get("db").first<Operation>(
    `SELECT operation_id AS "operationId", plugin_id AS "pluginId", type, target_version AS "targetVersion", state,
            manifest_sha256 AS "manifestSha256", worker_sha256 AS "workerSha256", d1_migrations_sha256 AS "d1MigrationsSha256",
            postgres_migrations_sha256 AS "postgresMigrationsSha256",
            assets_sha256 AS "assetsSha256", source_release_id AS "sourceReleaseId",
            last_error AS "lastError"
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
    actual.postgres !== operation.postgresMigrationsSha256 ||
    (operation.assetsSha256 != null && actual.assets !== operation.assetsSha256)
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
                  CASE WHEN p.status IN ('installed','disabled') AND EXISTS (
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

installerRoutes.patch(
  "/plugins/:pluginId",
  requirePermission("core.plugin.update"),
  async (c) => {
    const pluginId = c.req.param("pluginId");
    const body = (await c.req.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    if (typeof body?.enabled !== "boolean")
      throw new AppError(
        422,
        "PLUGIN_ENABLED_INVALID",
        "The enabled field must be a boolean.",
      );
    const plugin = await c.get("db").first<{
      workerName: string;
      status: string;
      packageFormat: number | string;
    }>(
      `SELECT worker_name AS "workerName", status,
              package_format AS "packageFormat"
         FROM plugins WHERE id = ?`,
      [pluginId],
    );
    if (!plugin)
      throw new AppError(404, "PLUGIN_NOT_FOUND", "Plugin not found.");
    const targetStatus = body.enabled ? "installed" : "disabled";
    if (plugin.status === targetStatus)
      return c.json({ id: pluginId, status: targetStatus }, 200, noStore);
    if (!["installed", "disabled"].includes(plugin.status))
      throw new AppError(
        409,
        "PLUGIN_STATE_CONFLICT",
        `The plugin cannot be changed while its status is ${plugin.status}.`,
      );

    if (body.enabled) {
      const missingDependency = await c.get("db").first<{ id: string }>(
        `SELECT l.dependency_plugin_id AS id
           FROM plugin_dependency_locks l
           LEFT JOIN plugins p ON p.id = l.dependency_plugin_id
            AND p.status = 'installed'
          WHERE l.plugin_id = ? AND p.id IS NULL LIMIT 1`,
        [pluginId],
      );
      if (missingDependency)
        throw new AppError(
          409,
          "PLUGIN_DEPENDENCY_DISABLED",
          `Activate dependency ${missingDependency.id} first.`,
        );
    } else {
      const activeDependent = await c.get("db").first<{ id: string }>(
        `SELECT l.plugin_id AS id
           FROM plugin_dependency_locks l
           JOIN plugins p ON p.id = l.plugin_id AND p.status = 'installed'
          WHERE l.dependency_plugin_id = ? LIMIT 1`,
        [pluginId],
      );
      if (activeDependent)
        throw new AppError(
          409,
          "PLUGIN_REQUIRED_BY_DEPENDENT",
          `Deactivate dependent plugin ${activeDependent.id} first.`,
        );
    }

    if (Number(plugin.packageFormat) === 2) {
      const resources = await readResourceRows(c, pluginId, {
        includePreserved: true,
      });
      if (body.enabled) {
        await configurePluginQueueConsumers(
          c.env,
          plugin.workerName,
          resources,
        );
        await configurePluginWorkerSchedules(
          c.env,
          plugin.workerName,
          resources,
        );
      } else {
        await removePluginQueueConsumers(c.env, plugin.workerName, resources);
        await configurePluginWorkerSchedules(c.env, plugin.workerName, []);
      }
    }

    const now = dbTime(c.get("db"));
    await commitWithEvent(
      c,
      [
        {
          sql: "UPDATE plugins SET status = ?, updated_at = ? WHERE id = ?",
          params: [targetStatus, now, pluginId],
        },
        {
          sql: "UPDATE plugin_assets SET active = ? WHERE plugin_id = ?",
          params: [body.enabled, pluginId],
        },
        {
          sql: "UPDATE plugin_contributions SET active = ? WHERE plugin_id = ?",
          params: [body.enabled, pluginId],
        },
      ],
      {
        eventType: body.enabled
          ? "core.plugin.activated"
          : "core.plugin.deactivated",
        resourceType: "core.plugin",
        resourceId: pluginId,
        data: { status: targetStatus },
      },
    );
    await audit(
      c,
      body.enabled ? "core.plugin.activated" : "core.plugin.deactivated",
      "core.plugin",
      pluginId,
      {},
    );
    return c.json({ id: pluginId, status: targetStatus }, 200, noStore);
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
  const supportsD1 = parts.manifest.databaseDialects.includes("d1");
  const supportsPostgres = parts.manifest.databaseDialects.includes("postgres");
  if (
    (supportsD1 && !d1Ids.length) ||
    (supportsPostgres && !postgresIds.length) ||
    (!supportsD1 && d1Ids.length > 0) ||
    (!supportsPostgres && postgresIds.length > 0) ||
    (supportsD1 &&
      supportsPostgres &&
      stableJson(d1Ids) !== stableJson(postgresIds))
  )
    throw new AppError(
      422,
      "PLUGIN_MIGRATIONS_UNPAIRED",
      "D1 and PostgreSQL migrations must have the same IDs.",
    );
  if (supportsD1)
    migrationStatements(parts.d1Migrations, parts.manifest.tablePrefix);
  if (supportsPostgres)
    migrationStatements(parts.postgresMigrations, parts.manifest.tablePrefix);
  verifyPortablePackageBoundary(
    c.env,
    parts,
    await runtimeBoundaryValues(c, parts.manifest.id),
  );
  let selectedSource:
    { marketplaceId: string; publisherId: string } | undefined;
  if (parts.sourceReleaseId) {
    const release = await c.get("db").first<{
      pluginId: string;
      version: string;
      marketplaceId: string;
      publisherId: string;
      artifactSha256: string;
      enabled: number | boolean;
      trustState: string;
      compatible: number | boolean;
      catalogExpiresAt: unknown;
    }>(
      `SELECT r.plugin_id AS "pluginId", r.version,
              r.marketplace_id AS "marketplaceId",
              r.publisher_id AS "publisherId",
              r.artifact_sha256 AS "artifactSha256", r.compatible,
              m.enabled, m.trust_state AS "trustState",
              m.catalog_expires_at AS "catalogExpiresAt"
         FROM plugin_releases r
         JOIN plugin_marketplaces m ON m.id = r.marketplace_id
        WHERE r.id = ? AND m.removed_at IS NULL`,
      [parts.sourceReleaseId],
    );
    if (
      !release ||
      release.pluginId !== parts.manifest.id ||
      release.version !== parts.manifest.version ||
      !parts.archiveSha256 ||
      release.artifactSha256 !== parts.archiveSha256 ||
      !Boolean(release.enabled) ||
      !Boolean(release.compatible) ||
      release.trustState !== "trusted" ||
      !release.catalogExpiresAt ||
      numberTime(release.catalogExpiresAt) < Date.now()
    )
      throw new AppError(
        409,
        "PLUGIN_MARKETPLACE_RELEASE_MISMATCH",
        "The package does not match the selected marketplace release.",
      );
    selectedSource = {
      marketplaceId: release.marketplaceId,
      publisherId: release.publisherId,
    };
  }
  const installed = await c.get("db").first<{
    installedVersion: string;
    status: string;
    packageFormat: number | string;
    marketplaceId: string | null;
    publisherId: string | null;
    releaseHash: string | null;
  }>(
    `SELECT installed_version AS "installedVersion", status,
            package_format AS "packageFormat",
            marketplace_id AS "marketplaceId",
            publisher_id AS "publisherId",
            release_hash AS "releaseHash"
           FROM plugins
          WHERE id = ? AND status IN ('installed','disabled')`,
    [parts.manifest.id],
  );
  if (installed?.status === "disabled")
    throw new AppError(
      409,
      "PLUGIN_DISABLED_ACTIVATE_FIRST",
      "Activate this plugin before updating it.",
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
  if (
    installed?.marketplaceId &&
    installed.marketplaceId !== selectedSource?.marketplaceId
  )
    throw new AppError(
      409,
      "PLUGIN_MARKETPLACE_ORIGIN_CHANGED",
      "Use an explicit publisher reassociation procedure before changing this plugin marketplace.",
    );
  if (
    installed?.publisherId &&
    installed.publisherId !==
      (selectedSource?.publisherId ?? parts.manifest.publisher?.id)
  )
    throw new AppError(
      409,
      "PLUGIN_PUBLISHER_CHANGED",
      "Use an explicit publisher reassociation procedure before changing this plugin publisher.",
    );
  if (
    installed &&
    Number(installed.packageFormat) === 2 &&
    parts.manifest.packageFormat === 2 &&
    parts.manifest.version === installed.installedVersion &&
    installed.releaseHash &&
    (await packageFilesDigest(parts.files)) !== installed.releaseHash
  )
    throw new AppError(
      409,
      "PLUGIN_RELEASE_IMMUTABILITY_VIOLATION",
      "An installed plugin version cannot be replaced with different package content.",
    );
  const operationType = installed ? "update" : "install";
  requirePluginOperationPermission(c, operationType);
  await resolveDependencies(c, parts.manifest);
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
    `INSERT INTO plugin_operations(operation_id, plugin_id, type, target_version, target_api_version, database_provider, manifest_sha256, worker_sha256, d1_migrations_sha256, postgres_migrations_sha256, assets_sha256, source_release_id, package_format, state, lock_acquired_at, lock_expires_at, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'validating', ?, ?, ?, ?)`,
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
      digest.assets,
      parts.sourceReleaseId ?? null,
      parts.manifest.packageFormat ?? 1,
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

installerRoutes.get("/plugin-operations/:operationId/resources", async (c) => {
  const operation = await getOperation(c);
  requirePluginOperationPermission(c, operation.type);
  const rows = await c.get("db").query<ResourceRow>(
    `SELECT logical_name AS "logicalName", resource_type AS type,
              binding_name AS binding, required, external_id AS "externalId",
              external_name AS "externalName", status,
              declaration_json AS configuration
         FROM plugin_resources_v2
        WHERE plugin_id = ? ORDER BY required DESC, logical_name`,
    [operation.pluginId],
  );
  return c.json(
    {
      operationId: operation.operationId,
      state: operation.state,
      items: rows.map((row) => ({
        logicalName: row.logicalName,
        type: row.type,
        binding: row.binding,
        required: Boolean(row.required),
        externalId: row.externalId,
        externalName: row.externalName,
        status: row.status,
      })),
    },
    200,
    noStore,
  );
});

installerRoutes.post(
  "/plugin-operations/:operationId/resources/:logicalName/provision",
  async (c) => {
    const operation = await getOperation(c);
    requirePluginOperationPermission(c, operation.type);
    await validateRecentReauth(c);
    if (!(c.req.header("Idempotency-Key") ?? "").trim())
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key is required for resource provisioning.",
      );
    const logicalName = c.req.param("logicalName") ?? "";
    if (!/^[a-z][a-z0-9_-]{0,47}$/u.test(logicalName))
      throw new AppError(
        404,
        "PLUGIN_RESOURCE_NOT_FOUND",
        "Plugin resource not found.",
      );
    const db = c.get("db");
    const resource = await db.first<ResourceRow>(
      `SELECT logical_name AS "logicalName", resource_type AS type,
              binding_name AS binding, required, external_id AS "externalId",
              external_name AS "externalName", status,
              declaration_json AS configuration
         FROM plugin_resources_v2
        WHERE plugin_id = ? AND logical_name = ?`,
      [operation.pluginId, logicalName],
    );
    if (!resource || !["r2", "kv", "queue"].includes(resource.type))
      throw new AppError(
        404,
        "PLUGIN_RESOURCE_NOT_FOUND",
        "Plugin resource not found or does not require provisioning.",
      );
    if (resource.status === "ready" && operation.state === "migrating")
      return c.json({
        operationId: operation.operationId,
        state: operation.state,
        resource: {
          logicalName,
          type: resource.type,
          binding: resource.binding,
          status: "ready",
        },
        replay: true,
      });
    if (operation.state !== "provisioning")
      throw new AppError(
        409,
        "OPERATION_NOT_PROVISIONING",
        "This operation is not waiting for resource provisioning.",
      );
    if (!c.env.CF_ACCOUNT_ID || !c.env.APP_INSTALLATION_ID)
      throw new AppError(
        503,
        "PLUGIN_RESOURCE_TARGET_MISSING",
        "The Cloudflare account or installation identifier is unavailable.",
      );
    const body = (await c.req.json().catch(() => null)) as {
      token?: unknown;
      mode?: unknown;
      externalName?: unknown;
      externalId?: unknown;
    } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!validCloudflareTokenLength(token))
      throw new AppError(
        422,
        "PLUGIN_RESOURCE_TOKEN_INVALID",
        "Enter a valid temporary Cloudflare resource token.",
      );
    const mode = body?.mode === "attach" ? "attach" : "create";
    const generatedName = await deterministicResourceName(
      c.env.APP_INSTALLATION_ID,
      operation.pluginId,
      logicalName,
    );
    const requestedName =
      mode === "attach" && typeof body?.externalName === "string"
        ? body.externalName.trim()
        : generatedName;
    const requestedId =
      mode === "attach" && typeof body?.externalId === "string"
        ? body.externalId.trim()
        : undefined;
    if (
      (resource.type === "r2" &&
        !/^[a-z0-9][a-z0-9-]{2,62}$/u.test(requestedName)) ||
      (resource.type !== "r2" &&
        !/^[A-Za-z0-9][A-Za-z0-9 _.-]{2,127}$/u.test(requestedName))
    )
      throw new AppError(
        422,
        "PLUGIN_RESOURCE_NAME_INVALID",
        "The Cloudflare resource name is invalid.",
      );
    if (resource.externalName && resource.externalName !== requestedName)
      throw new AppError(
        409,
        "PLUGIN_RESOURCE_IDENTITY_CONFLICT",
        "A different preserved resource is already registered for this plugin.",
      );
    const now = dbTime(db);
    await db.execute(
      `UPDATE plugin_resources_v2
          SET status = 'provisioning', updated_at = ?, last_error_code = NULL
        WHERE plugin_id = ? AND logical_name = ?`,
      [now, operation.pluginId, logicalName],
    );
    const declaration = parseJson<{
      configuration?: { jurisdiction?: "eu" | "fedramp" | "us" };
    }>(resource.configuration, {});
    try {
      const result = await provisionPluginResource(
        token,
        c.env.CF_ACCOUNT_ID,
        resource.type === "r2"
          ? { type: "r2", mode, name: requestedName }
          : resource.type === "kv"
            ? {
                type: "kv",
                mode,
                name: requestedName,
                ...(requestedId ? { id: requestedId } : {}),
                ...(declaration.configuration?.jurisdiction
                  ? { jurisdiction: declaration.configuration.jurisdiction }
                  : {}),
              }
            : {
                type: "queue",
                mode,
                name: requestedName,
                ...(requestedId ? { id: requestedId } : {}),
              },
      );
      const verifiedAt = dbTime(db);
      await db.execute(
        `UPDATE plugin_resources_v2
            SET external_id = ?, external_name = ?, status = 'ready',
                last_error_code = NULL, updated_at = ?, preserved_at = NULL
          WHERE plugin_id = ? AND logical_name = ?`,
        [
          result.externalId,
          result.externalName,
          verifiedAt,
          operation.pluginId,
          logicalName,
        ],
      );
      const pending = await db.first<{ count: number | string }>(
        `SELECT COUNT(*) AS count FROM plugin_resources_v2
          WHERE plugin_id = ? AND required = ?
            AND status NOT IN ('ready', 'preserved')`,
        [operation.pluginId, true],
      );
      const nextState =
        Number(pending?.count ?? 0) === 0 ? "migrating" : "provisioning";
      await db.execute(
        "UPDATE plugin_operations SET state = ?, lock_expires_at = ? WHERE operation_id = ? AND state = 'provisioning'",
        [nextState, dbTime(db, Date.now() + 300_000), operation.operationId],
      );
      await audit(
        c,
        "core.plugin.resource_ready",
        "core.plugin",
        operation.pluginId,
        {
          operationId: operation.operationId,
          logicalName,
          resourceType: resource.type,
          created: result.created,
        },
      );
      return c.json({
        operationId: operation.operationId,
        state: nextState,
        resource: {
          logicalName,
          type: resource.type,
          binding: resource.binding,
          status: "ready",
        },
      });
    } catch (error) {
      const code =
        error instanceof PluginResourceProvisioningError
          ? error.code
          : "unavailable";
      await db.atomic([
        {
          sql: `UPDATE plugin_resources_v2
                   SET status = 'error', last_error_code = ?, updated_at = ?
                 WHERE plugin_id = ? AND logical_name = ?`,
          params: [code, dbTime(db), operation.pluginId, logicalName],
        },
        {
          sql: "UPDATE plugin_operations SET state = 'failed', last_error = ? WHERE operation_id = ?",
          params: [
            JSON.stringify({
              from: "provisioning",
              detail: `resource_${resource.type}_${code}`,
              requestId: c.get("requestId"),
              failedAt: Date.now(),
            }),
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
      const message =
        code === "conflict"
          ? "A Cloudflare resource with this generated name already exists; attach it explicitly if it belongs to this installation."
          : code === "not_found"
            ? "The Cloudflare resource to attach was not found."
            : code === "not_entitled"
              ? "Activate this Cloudflare product before installing the plugin."
              : code === "invalid"
                ? "The temporary token or target resource is invalid."
                : "Cloudflare could not provision the plugin resource.";
      throw new AppError(
        code === "unavailable" ? 503 : code === "not_entitled" ? 409 : 422,
        `PLUGIN_RESOURCE_${code.toUpperCase()}`,
        message,
      );
    }
  },
);

installerRoutes.post(
  "/plugins/:pluginId/runtime-resources/r2",
  requirePermission("core.plugin.update"),
  async (c) => {
    await validateRecentReauth(c);
    if (!c.env.CF_ACCOUNT_ID || !c.env.APP_INSTALLATION_ID)
      throw new AppError(
        503,
        "R2_PROVISIONING_TARGET_MISSING",
        "The Cloudflare account or installation identifier is unavailable.",
      );
    const pluginId = c.req.param("pluginId");
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
    const plugin = await c.get("db").first<{
      workerName: string;
      status: string;
      manifestJson: string;
    }>(
      `SELECT worker_name AS "workerName", status, manifest_json AS "manifestJson"
         FROM plugins WHERE id = ?`,
      [pluginId],
    );
    if (!plugin || plugin.status !== "installed")
      throw new AppError(
        404,
        "PLUGIN_NOT_INSTALLED",
        "Plugin is not installed.",
      );
    let manifest: PluginManifest;
    try {
      manifest = pluginManifestSchema.parse(JSON.parse(plugin.manifestJson));
    } catch {
      throw new AppError(
        409,
        "PLUGIN_MANIFEST_INVALID",
        "The installed plugin manifest is invalid.",
      );
    }
    if (!manifest.optionalRuntimeBindings?.includes("r2"))
      throw new AppError(
        409,
        "PLUGIN_RUNTIME_R2_NOT_OPTIONAL",
        "This plugin does not support optional R2 activation.",
      );
    const deterministicName = await deterministicR2BucketName(
      c.env.APP_INSTALLATION_ID,
      pluginId,
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
    const idem = await idempotencyLookup(
      c,
      "plugin_runtime_resources.r2.activate",
      { pluginId, mode, requestedName, token },
      true,
    );
    if (idem?.replay)
      return c.json(idem.replay.body as never, idem.replay.status as 200);

    const db = c.get("db");
    const existing = await db.first<{
      externalName: string;
      status: string;
    }>(
      `SELECT external_name AS "externalName", status
         FROM plugin_runtime_resources
        WHERE plugin_id = ? AND binding_name = 'STORAGE'`,
      [pluginId],
    );
    if (existing && existing.externalName !== requestedName)
      throw new AppError(
        409,
        "R2_BUCKET_CONFLICT",
        "A different preserved bucket is already registered for this plugin.",
      );

    const activationId = createId("r2a");
    const now = Date.now();
    const lock = await db.execute(
      `UPDATE installer_lock SET operation_id = ?, acquired_at = ?, expires_at = ?
        WHERE id = 'global' AND (operation_id IS NULL OR expires_at < ?)`,
      [
        activationId,
        dbTime(db, now),
        dbTime(db, now + 300_000),
        dbTime(db, now),
      ],
    );
    if (!lock.rowsAffected)
      throw new AppError(
        409,
        "INSTALLER_BUSY",
        "Another installation is in progress.",
      );
    try {
      const reservedAt = dbTime(db);
      const reserved = await db.execute(
        `INSERT INTO plugin_runtime_resources(
           plugin_id, resource_type, binding_name, external_name, status,
           created_by_operation_id, created_at, updated_at
         ) VALUES (?, 'r2', 'STORAGE', ?, 'provisioning', ?, ?, ?)
         ON CONFLICT(plugin_id, binding_name) DO UPDATE SET
           status = 'provisioning', created_by_operation_id = excluded.created_by_operation_id,
           updated_at = excluded.updated_at, last_error_code = NULL
         WHERE plugin_runtime_resources.external_name = excluded.external_name`,
        [pluginId, requestedName, activationId, reservedAt, reservedAt],
      );
      if (!reserved.rowsAffected)
        throw new AppError(
          409,
          "R2_BUCKET_CONFLICT",
          "The requested R2 bucket conflicts with a registered resource.",
        );
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
      await attachPluginR2Binding(c.env, plugin.workerName, requestedName);
      const verifiedAt = dbTime(db);
      await db.execute(
        `UPDATE plugin_runtime_resources
            SET status = 'ready', last_verified_at = ?, last_error_code = NULL,
                updated_at = ?, preserved_at = NULL
          WHERE plugin_id = ? AND binding_name = 'STORAGE' AND external_name = ?`,
        [verifiedAt, verifiedAt, pluginId, requestedName],
      );
      const response = {
        pluginId,
        status: "ready",
        resource: { type: "r2", binding: "STORAGE" },
      };
      await saveIdempotency(
        c,
        "plugin_runtime_resources.r2.activate",
        idem,
        200,
        response,
      );
      await audit(
        c,
        "core.plugin.runtime_resource_ready",
        "core.plugin",
        pluginId,
        { activationId, resourceType: "r2" },
      );
      return c.json(response, 200, noStore);
    } catch (error) {
      const code =
        error instanceof R2ProvisioningError ? error.code : "unavailable";
      await db.execute(
        `UPDATE plugin_runtime_resources
            SET status = ?, last_error_code = ?, updated_at = ?
          WHERE plugin_id = ? AND binding_name = 'STORAGE'`,
        [
          code === "bucket_missing" ? "missing" : "error",
          code,
          dbTime(db),
          pluginId,
        ],
      );
      if (error instanceof AppError) throw error;
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
                  "Activate R2 on this Cloudflare account before enabling audio storage.",
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
                      "Cloudflare could not enable the private R2 bucket.",
                    ];
      throw new AppError(
        mapped[0] as 404 | 409 | 422 | 503,
        mapped[1] as string,
        mapped[2] as string,
      );
    } finally {
      await db.execute(
        `UPDATE installer_lock SET operation_id = NULL, acquired_at = NULL,
            expires_at = NULL WHERE id = 'global' AND operation_id = ?`,
        [activationId],
      );
    }
  },
);

installerRoutes.get(
  "/plugins/:pluginId/runtime-resources",
  requirePermission("core.plugin.read"),
  async (c) => {
    const pluginId = c.req.param("pluginId") ?? "";
    const plugin = await c
      .get("db")
      .first<{ status: string }>("SELECT status FROM plugins WHERE id = ?", [
        pluginId,
      ]);
    if (!plugin || plugin.status !== "installed")
      throw new AppError(
        404,
        "PLUGIN_NOT_INSTALLED",
        "Plugin is not installed.",
      );
    const items = await c.get("db").query<ResourceRow>(
      `SELECT logical_name AS "logicalName", resource_type AS type,
              binding_name AS binding, required, external_id AS "externalId",
              external_name AS "externalName", status,
              declaration_json AS configuration
         FROM plugin_resources_v2 WHERE plugin_id = ? ORDER BY logical_name`,
      [pluginId],
    );
    return c.json(
      {
        items: items.map((resource) => ({
          logicalName: resource.logicalName,
          type: resource.type,
          binding: resource.binding,
          required: Boolean(resource.required),
          status: resource.status,
          configured: resource.status === "ready",
        })),
      },
      200,
      noStore,
    );
  },
);

installerRoutes.post(
  "/plugins/:pluginId/runtime-resources/:logicalName/provision",
  requirePermission("core.plugin.update"),
  async (c) => {
    await validateRecentReauth(c);
    const pluginId = c.req.param("pluginId") ?? "";
    const logicalName = c.req.param("logicalName") ?? "";
    const plugin = await c.get("db").first<{
      status: string;
      workerName: string;
      packageFormat: number | string;
    }>(
      `SELECT status, worker_name AS "workerName",
              package_format AS "packageFormat"
         FROM plugins WHERE id = ?`,
      [pluginId],
    );
    if (!plugin || plugin.status !== "installed")
      throw new AppError(
        404,
        "PLUGIN_NOT_INSTALLED",
        "Plugin is not installed.",
      );
    if (Number(plugin.packageFormat) !== 2)
      throw new AppError(
        409,
        "PLUGIN_RESOURCE_FORMAT_UNSUPPORTED",
        "Use the legacy resource endpoint for this plugin package.",
      );
    const resource = await c.get("db").first<ResourceRow>(
      `SELECT logical_name AS "logicalName", resource_type AS type,
              binding_name AS binding, required, external_id AS "externalId",
              external_name AS "externalName", status,
              declaration_json AS configuration
         FROM plugin_resources_v2
        WHERE plugin_id = ? AND logical_name = ?`,
      [pluginId, logicalName],
    );
    if (!resource || !["r2", "kv", "queue"].includes(resource.type))
      throw new AppError(
        404,
        "PLUGIN_RESOURCE_NOT_FOUND",
        "Plugin resource not found.",
      );
    if (!c.env.CF_ACCOUNT_ID || !c.env.APP_INSTALLATION_ID)
      throw new AppError(
        503,
        "PLUGIN_RESOURCE_TARGET_MISSING",
        "The Cloudflare account or installation identifier is unavailable.",
      );
    const body = (await c.req.json().catch(() => null)) as {
      token?: unknown;
      mode?: unknown;
      externalName?: unknown;
      externalId?: unknown;
    } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!validCloudflareTokenLength(token))
      throw new AppError(
        422,
        "PLUGIN_RESOURCE_TOKEN_INVALID",
        "Enter a valid temporary Cloudflare resource token.",
      );
    const generatedName = await deterministicResourceName(
      c.env.APP_INSTALLATION_ID,
      pluginId,
      logicalName,
    );
    const requestedMode = body?.mode === "attach" ? "attach" : "create";
    const mode = resource.externalName ? "attach" : requestedMode;
    const name =
      resource.externalName ??
      (mode === "attach" && typeof body?.externalName === "string"
        ? body.externalName.trim()
        : generatedName);
    const id =
      resource.externalId ??
      (mode === "attach" && typeof body?.externalId === "string"
        ? body.externalId.trim()
        : undefined);
    let provisioned:
      | { externalId: string | null; externalName: string; created: boolean }
      | undefined;
    const declaration = parseJson<{
      configuration?: { jurisdiction?: "eu" | "fedramp" | "us" };
    }>(resource.configuration, {});
    try {
      provisioned = await provisionPluginResource(
        token,
        c.env.CF_ACCOUNT_ID,
        resource.type === "r2"
          ? { type: "r2", mode, name }
          : resource.type === "kv"
            ? {
                type: "kv",
                mode,
                name,
                ...(id ? { id } : {}),
                ...(declaration.configuration?.jurisdiction
                  ? { jurisdiction: declaration.configuration.jurisdiction }
                  : {}),
              }
            : { type: "queue", mode, name, ...(id ? { id } : {}) },
      );
      const resolved: PluginRuntimeResource = {
        logicalName,
        type: resource.type,
        binding: resource.binding,
        required: Boolean(resource.required),
        externalId: provisioned.externalId,
        externalName: provisioned.externalName,
        configuration: declaration.configuration ?? {},
      };
      const now = dbTime(c.get("db"));
      await c.get("db").execute(
        `UPDATE plugin_resources_v2
            SET external_id = ?, external_name = ?, status = 'provisioning',
                updated_at = ?, last_error_code = NULL
          WHERE plugin_id = ? AND logical_name = ?`,
        [
          provisioned.externalId,
          provisioned.externalName,
          now,
          pluginId,
          logicalName,
        ],
      );
      await attachPluginResourceBinding(c.env, plugin.workerName, resolved);
      if (resolved.type === "queue")
        await configurePluginQueueConsumers(
          c.env,
          plugin.workerName,
          await readResourceRows(c, pluginId),
        );
      await c.get("db").execute(
        `UPDATE plugin_resources_v2
            SET status = 'ready', updated_at = ?, preserved_at = NULL
          WHERE plugin_id = ? AND logical_name = ?`,
        [dbTime(c.get("db")), pluginId, logicalName],
      );
      await audit(
        c,
        "core.plugin.resource_activated",
        "core.plugin",
        pluginId,
        {
          logicalName,
          resourceType: resource.type,
          created: provisioned.created,
        },
      );
      return c.json(
        { logicalName, type: resource.type, status: "ready" },
        200,
        noStore,
      );
    } catch (error) {
      const code =
        error instanceof PluginResourceProvisioningError
          ? error.code
          : "binding_failed";
      await c.get("db").execute(
        `UPDATE plugin_resources_v2
            SET external_id = ?, external_name = ?, status = 'error',
                last_error_code = ?, updated_at = ?
          WHERE plugin_id = ? AND logical_name = ?`,
        [
          provisioned?.externalId ?? resource.externalId,
          provisioned?.externalName ?? resource.externalName,
          code,
          dbTime(c.get("db")),
          pluginId,
          logicalName,
        ],
      );
      throw new AppError(
        code === "binding_failed" || code === "unavailable" ? 503 : 422,
        `PLUGIN_RESOURCE_${code.toUpperCase()}`,
        "The plugin resource could not be activated safely.",
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
    let detail = error instanceof Error ? error.message : "unknown";
    if (
      operation.type === "update" &&
      ["deploying", "hardening", "binding", "registering"].includes(from)
    )
      try {
        await restorePreviousPluginWorker(c, operation);
      } catch (rollbackError) {
        detail = `${detail};rollback_failed:${
          rollbackError instanceof Error ? rollbackError.message : "unknown"
        }`;
      }
    await recordFailure(from, detail);
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
      const v2ResourceProvisioning = await reconcileResourcePlan(
        c,
        operation,
        parts.manifest,
      );
      const resource = await db.first<{ status: string }>(
        `SELECT status FROM plugin_runtime_resources
          WHERE plugin_id = ? AND binding_name = 'STORAGE'`,
        [operation.pluginId],
      );
      const nextState =
        v2ResourceProvisioning ||
        (parts.manifest.runtimeBindings?.includes("r2") &&
          resource?.status !== "ready")
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
        "PLUGIN_RUNTIME_RESOURCE_REQUIRED",
        "Provision every required plugin resource before advancing this operation.",
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
      const targetWorkerName = await operationWorkerName(c, operation);
      const v2Resources = await readResourceRows(c, operation.pluginId);
      const resource = hasR2Capability(parts.manifest)
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
        targetWorkerName,
        parts.worker,
        parts.manifest,
        [
          ...v2Resources,
          ...(resource?.status === "ready" &&
          !v2Resources.some((entry) => entry.binding === "STORAGE")
            ? [
                {
                  logicalName: "storage",
                  type: "r2" as const,
                  binding: "STORAGE",
                  required: Boolean(
                    parts.manifest.runtimeBindings?.includes("r2"),
                  ),
                  externalName: resource.externalName,
                  externalId: null,
                  configuration: {},
                },
              ]
            : []),
        ],
        parts.files,
      );
      if (parts.manifest.packageFormat === 2) {
        await configurePluginQueueConsumers(
          c.env,
          targetWorkerName,
          v2Resources,
        );
        await configurePluginWorkerSchedules(
          c.env,
          targetWorkerName,
          v2Resources,
        );
      }
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
      const targetWorkerName = await operationWorkerName(c, operation);
      await hardenPluginWorker(c.env, targetWorkerName);
      await db.execute(
        "UPDATE plugin_operations SET state = 'binding' WHERE operation_id = ?",
        [operation.operationId],
      );
      return c.json({ operationId: operation.operationId, state: "binding" });
    }
    if (operation.state === "binding") {
      const targetWorkerName = await operationWorkerName(c, operation);
      await mergeCoreServiceBinding(
        c.env,
        bindingName(operation.pluginId),
        targetWorkerName,
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
      const targetWorkerName = await operationWorkerName(c, operation);
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
      const releaseHash = await packageFilesDigest(parts.files);
      const assetStatements: SqlStatement[] = [];
      const assetRows: SqlValue[][] = [];
      const contributionRows: SqlValue[][] = [];
      if (parts.manifest.frontend) {
        assetStatements.push({
          sql: "UPDATE plugin_assets SET active = ? WHERE plugin_id = ? AND active = ?",
          params: [false, operation.pluginId, true],
        });
        assetStatements.push({
          sql: "UPDATE plugin_contributions SET active = ? WHERE plugin_id = ? AND active = ?",
          params: [false, operation.pluginId, true],
        });
        for (const [path, encoded] of Object.entries(parts.files)) {
          if (
            !path.startsWith("frontend/") &&
            !path.startsWith("locales/") &&
            path !== "openapi.json"
          )
            continue;
          const bytes = decodePackageFile(encoded);
          const extension = path.split(".").at(-1)?.toLowerCase();
          const contentType =
            extension === "js" || extension === "mjs"
              ? "text/javascript; charset=utf-8"
              : extension === "css"
                ? "text/css; charset=utf-8"
                : extension === "json"
                  ? "application/json; charset=utf-8"
                  : extension === "svg"
                    ? "image/svg+xml"
                    : extension === "png"
                      ? "image/png"
                      : extension === "webp"
                        ? "image/webp"
                        : extension === "woff2"
                          ? "font/woff2"
                          : "application/octet-stream";
          assetRows.push([
            operation.pluginId,
            releaseHash,
            path,
            contentType,
            operation.operationId,
            await sha256(bytes),
            bytes.byteLength,
            true,
            now,
          ]);
        }
        for (const route of parts.manifest.frontend.routes)
          contributionRows.push([
            operation.pluginId,
            releaseHash,
            "route",
            route.routeKey,
            JSON.stringify(route),
            true,
            now,
          ]);
        for (const menu of parts.manifest.menu)
          contributionRows.push([
            operation.pluginId,
            releaseHash,
            "menu",
            menu.routeKey,
            JSON.stringify(menu),
            true,
            now,
          ]);
        assetStatements.push(
          ...bulkStatements(
            `INSERT INTO plugin_assets(
              plugin_id, release_hash, path, content_type, operation_id,
              sha256, byte_length, active, created_at) VALUES`,
            assetRows,
            `ON CONFLICT(plugin_id, release_hash, path) DO UPDATE SET
              content_type=excluded.content_type,
              operation_id=excluded.operation_id,
              sha256=excluded.sha256,
              byte_length=excluded.byte_length,
              active=excluded.active`,
          ),
          ...bulkStatements(
            `INSERT INTO plugin_contributions(
              plugin_id, release_hash, kind, contribution_id,
              payload_json, active, created_at) VALUES`,
            contributionRows,
            `ON CONFLICT(plugin_id, release_hash, kind, contribution_id)
              DO UPDATE SET payload_json=excluded.payload_json,
                active=excluded.active`,
          ),
        );
      }
      const sourceRelease = operation.sourceReleaseId
        ? await db.first<{ marketplaceId: string; publisherId: string }>(
            `SELECT marketplace_id AS "marketplaceId", publisher_id AS "publisherId"
               FROM plugin_releases WHERE id = ?`,
            [operation.sourceReleaseId],
          )
        : null;
      const dependencyLocks = await resolveDependencies(c, parts.manifest);
      const previousPlugin = await db.first<{ releaseHash: string | null }>(
        `SELECT release_hash AS "releaseHash" FROM plugins
          WHERE id = ? AND status = 'installed'`,
        [operation.pluginId],
      );
      const previousPackage = await db.first<{ operationId: string }>(
        `SELECT operation_id AS "operationId" FROM plugin_operations
          WHERE plugin_id = ? AND state = 'installed' AND operation_id <> ?
          ORDER BY finished_at DESC LIMIT 1`,
        [operation.pluginId, operation.operationId],
      );
      await commitWithEvent(
        c,
        [
          {
            sql: `INSERT INTO plugins(id, name, installed_version, api_version, database_dialects_json, active_database_provider, worker_name, status, manifest_json, installed_at, updated_at, package_format, marketplace_id, publisher_id, release_id, release_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'installed', ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, installed_version=excluded.installed_version, api_version=excluded.api_version, worker_name=excluded.worker_name, status='installed', manifest_json=excluded.manifest_json, updated_at=excluded.updated_at, package_format=excluded.package_format, marketplace_id=excluded.marketplace_id, publisher_id=excluded.publisher_id, release_id=excluded.release_id, release_hash=excluded.release_hash`,
            params: [
              parts.manifest.id,
              parts.manifest.name,
              parts.manifest.version,
              parts.manifest.apiVersion,
              JSON.stringify(parts.manifest.databaseDialects),
              c.env.DATABASE_PROVIDER,
              targetWorkerName,
              JSON.stringify(parts.manifest),
              now,
              now,
              parts.manifest.packageFormat ?? 1,
              sourceRelease?.marketplaceId ?? null,
              sourceRelease?.publisherId ??
                parts.manifest.publisher?.id ??
                null,
              operation.sourceReleaseId,
              parts.manifest.frontend ? releaseHash : null,
            ],
          },
          ...assetStatements,
          ...bulkStatements(
            db.provider === "d1"
              ? "INSERT OR IGNORE INTO permissions(id,key,created_at) VALUES"
              : "INSERT INTO permissions(id,key,created_at) VALUES",
            parts.manifest.permissions.map((key) => [
              `perm_${key.replaceAll(".", "_")}`,
              key,
              now,
            ]),
            db.provider === "postgres" ? "ON CONFLICT (key) DO NOTHING" : "",
          ),
          ...bulkStatements(
            db.provider === "d1"
              ? "INSERT OR IGNORE INTO group_permissions(group_id,permission_id,created_at) VALUES"
              : "INSERT INTO group_permissions(group_id,permission_id,created_at) VALUES",
            permissionIds.map((permissionId) => [
              "grp_administrators",
              permissionId,
              now,
            ]),
            db.provider === "postgres"
              ? "ON CONFLICT (group_id,permission_id) DO NOTHING"
              : "",
          ),
          {
            sql: "DELETE FROM plugin_dependency_locks WHERE plugin_id = ?",
            params: [operation.pluginId],
          },
          ...bulkStatements(
            `INSERT INTO plugin_dependency_locks(
              plugin_id, dependency_plugin_id, version,
              marketplace_id, release_id, created_at) VALUES`,
            dependencyLocks.map((dependency) => [
              operation.pluginId,
              dependency.pluginId,
              dependency.version,
              dependency.marketplaceId,
              dependency.releaseId,
              now,
            ]),
          ),
          ...(parts.manifest.frontend
            ? [
                {
                  sql: `DELETE FROM plugin_assets
                         WHERE plugin_id = ? AND release_hash <> ?
                           AND (? IS NULL OR release_hash <> ?)`,
                  params: [
                    operation.pluginId,
                    releaseHash,
                    previousPlugin?.releaseHash ?? null,
                    previousPlugin?.releaseHash ?? null,
                  ],
                },
                {
                  sql: `DELETE FROM plugin_contributions
                         WHERE plugin_id = ? AND release_hash <> ?
                           AND (? IS NULL OR release_hash <> ?)`,
                  params: [
                    operation.pluginId,
                    releaseHash,
                    previousPlugin?.releaseHash ?? null,
                    previousPlugin?.releaseHash ?? null,
                  ],
                },
              ]
            : []),
          {
            sql: `DELETE FROM plugin_package_chunks
                   WHERE operation_id IN (
                     SELECT operation_id FROM plugin_operations
                      WHERE plugin_id = ? AND operation_id <> ?
                        AND (? IS NULL OR operation_id <> ?)
                   )`,
            params: [
              operation.pluginId,
              operation.operationId,
              previousPackage?.operationId ?? null,
              previousPackage?.operationId ?? null,
            ],
          },
          {
            sql: "UPDATE plugin_operations SET state = 'installed', finished_at = ? WHERE operation_id = ?",
            params: [now, operation.operationId],
          },
          ...(hasR2Capability(parts.manifest)
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
            workerName: targetWorkerName,
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
    if (
      !["installed", "disabled"].includes(plugin.status) ||
      !plugin.installedVersion
    )
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
      assetsSha256: string | null;
    }>(
      `SELECT operation_id AS "operationId", manifest_sha256 AS "manifestSha256",
              worker_sha256 AS "workerSha256", d1_migrations_sha256 AS "d1MigrationsSha256",
              postgres_migrations_sha256 AS "postgresMigrationsSha256",
              assets_sha256 AS "assetsSha256"
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
        ...(operation.assetsSha256 ? { assets: operation.assetsSha256 } : {}),
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
    if (
      !["installed", "disabled"].includes(plugin.status) ||
      !plugin.installedVersion
    )
      throw new AppError(
        409,
        "PLUGIN_PACKAGE_EXPORT_NOT_INSTALLED",
        "Only an installed plugin can have its portable package restored.",
      );

    const operation = await c.get("db").first<Operation>(
      `SELECT operation_id AS "operationId", plugin_id AS "pluginId", type, target_version AS "targetVersion", state,
              manifest_sha256 AS "manifestSha256", worker_sha256 AS "workerSha256",
              d1_migrations_sha256 AS "d1MigrationsSha256",
              postgres_migrations_sha256 AS "postgresMigrationsSha256",
              assets_sha256 AS "assetsSha256",
              source_release_id AS "sourceReleaseId", last_error AS "lastError"
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
      const supportsD1 = parts.manifest.databaseDialects.includes("d1");
      const supportsPostgres =
        parts.manifest.databaseDialects.includes("postgres");
      if (
        (supportsD1 && !d1Ids.length) ||
        (supportsPostgres && !postgresIds.length) ||
        (!supportsD1 && d1Ids.length > 0) ||
        (!supportsPostgres && postgresIds.length > 0) ||
        (supportsD1 &&
          supportsPostgres &&
          stableJson(d1Ids) !== stableJson(postgresIds))
      )
        throw new Error("Plugin migrations are not paired.");
      if (supportsD1)
        migrationStatements(parts.d1Migrations, parts.manifest.tablePrefix);
      if (supportsPostgres)
        migrationStatements(
          parts.postgresMigrations,
          parts.manifest.tablePrefix,
        );
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
    const plugin = await c.get("db").first<{
      workerName: string;
      status: string;
      packageFormat: number | string;
    }>(
      `SELECT worker_name AS "workerName", status,
                package_format AS "packageFormat"
           FROM plugins WHERE id = ?`,
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
    if (!["installed", "disabled"].includes(plugin.status))
      throw new AppError(
        409,
        "PLUGIN_STATE_CONFLICT",
        `The plugin cannot be removed while its status is ${plugin.status}.`,
      );
    const dependent = await c.get("db").first<{ id: string }>(
      `SELECT l.plugin_id AS id
         FROM plugin_dependency_locks l
         JOIN plugins p ON p.id = l.plugin_id AND p.status IN ('installed','disabled')
        WHERE l.dependency_plugin_id = ? LIMIT 1`,
      [pluginId],
    );
    if (dependent)
      throw new AppError(
        409,
        "PLUGIN_REQUIRED_BY_DEPENDENT",
        `Uninstall dependent plugin ${dependent.id} first.`,
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
      {
        sql: `UPDATE plugin_resources_v2
                 SET status = 'preserving', updated_at = ?
               WHERE plugin_id = ? AND status IN ('ready','error')`,
        params: [uninstallingAt, pluginId],
      },
    ]);
    await removeCoreServiceBinding(c.env, bindingName(pluginId));
    const durableObject = await c.get("db").first<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM plugin_resources_v2
        WHERE plugin_id = ? AND resource_type = 'durable_object'`,
      [pluginId],
    );
    const preserveWorker = Number(durableObject?.count ?? 0) > 0;
    if (Number(plugin.packageFormat) === 2) {
      const resources = await readResourceRows(c, pluginId, {
        includePreserved: true,
      });
      await removePluginQueueConsumers(c.env, plugin.workerName, resources);
      await configurePluginWorkerSchedules(c.env, plugin.workerName, []);
    }
    if (!preserveWorker) await deletePluginWorker(c.env, plugin.workerName);
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
          sql: "UPDATE plugin_assets SET active = ? WHERE plugin_id = ?",
          params: [false, pluginId],
        },
        {
          sql: "UPDATE plugin_contributions SET active = ? WHERE plugin_id = ?",
          params: [false, pluginId],
        },
        {
          sql: "DELETE FROM plugin_dependency_locks WHERE plugin_id = ?",
          params: [pluginId],
        },
        {
          sql: `UPDATE plugin_runtime_resources
                   SET status = 'preserved', preserved_at = ?, updated_at = ?
                 WHERE plugin_id = ? AND binding_name = 'STORAGE'`,
          params: [dbTime(c.get("db")), dbTime(c.get("db")), pluginId],
        },
        {
          sql: `UPDATE plugin_resources_v2
                   SET status = 'preserved', preserved_at = ?, updated_at = ?
                 WHERE plugin_id = ?`,
          params: [dbTime(c.get("db")), dbTime(c.get("db")), pluginId],
        },
      ],
      {
        eventType: "core.plugin.uninstalled",
        resourceType: "core.plugin",
        resourceId: pluginId,
        data: {
          tablesPreserved: true,
          resourcesPreserved: true,
          workerPreservedForDurableObjects: preserveWorker,
        },
      },
    );
    await audit(c, "core.plugin.uninstalled", "core.plugin", pluginId, {
      resourcesPreserved: true,
      workerPreservedForDurableObjects: preserveWorker,
    });
    return c.body(null, 204);
  },
);
