import type { CoreEnv } from "../env.js";
import {
  isWorkerModuleContentType,
  type InstallerRelease,
  type ReleaseAsset,
} from "@app/installer-release-schema";
import type { VerifiedCoreArchive } from "../updates/release.js";
import { decodePackageFile } from "./package-v2.js";

type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
};
export type Binding = Record<string, unknown> & { name: string; type: string };

type AssetUploadSession = { buckets: string[][]; jwt: string };
type WorkerSettings = {
  bindings?: Binding[];
  compatibility_date?: string;
  compatibility_flags?: string[];
};

const apiOrigin = "https://api.cloudflare.com";
const apiPrefix = "/client/v4";
const maximumResponseBytes = 2 * 1024 * 1024;

class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly codes: string[],
  ) {
    super(`Cloudflare API failed (${status}): ${codes.join(",") || "unknown"}`);
  }
}

export class PluginRuntimeCredentialError extends Error {
  constructor(
    readonly code: "invalid" | "too_broad" | "target_missing" | "save_failed",
  ) {
    super(code);
  }
}

export class R2ProvisioningError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "too_broad"
      | "not_entitled"
      | "bucket_missing"
      | "bucket_conflict"
      | "unavailable",
  ) {
    super(code);
  }
}

export class PluginResourceProvisioningError extends Error {
  constructor(
    readonly code:
      "invalid" | "not_found" | "conflict" | "not_entitled" | "unavailable",
  ) {
    super(code);
  }
}

export type PluginRuntimeResource = {
  logicalName: string;
  type: "database" | "r2" | "kv" | "queue" | "durable_object" | "cron" | "ai";
  binding: string;
  required: boolean;
  externalId?: string | null;
  externalName?: string | null;
  configuration: Record<string, unknown>;
};

async function readBoundedText(response: Response): Promise<string> {
  const declaredSize = Number(response.headers.get("Content-Length") ?? "0");
  if (declaredSize > maximumResponseBytes)
    throw new CloudflareApiError(response.status, ["RESPONSE_TOO_LARGE"]);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumResponseBytes) {
      await reader.cancel();
      throw new CloudflareApiError(response.status, ["RESPONSE_TOO_LARGE"]);
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

async function cloudflareRequest<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!path.startsWith("/"))
    throw new Error("Cloudflare path must be absolute");
  const url = new URL(`${apiPrefix}${path}`, apiOrigin);
  if (url.origin !== apiOrigin || !url.pathname.startsWith(apiPrefix))
    throw new Error("Cloudflare API destination rejected");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  const text = await readBoundedText(response);
  let envelope: CloudflareEnvelope<T> | undefined;
  try {
    envelope = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : undefined;
  } catch {
    throw new CloudflareApiError(response.status, ["MALFORMED_RESPONSE"]);
  }
  if (!response.ok || !envelope?.success) {
    const codes = (envelope?.errors ?? []).map((error) =>
      String(error.code ?? "API_ERROR"),
    );
    throw new CloudflareApiError(
      response.status,
      codes.length ? codes : [String(response.status)],
    );
  }
  return envelope.result;
}

const accountPath = (accountId: string): string =>
  `/accounts/${encodeURIComponent(accountId)}`;

async function verifyCloudflareToken(
  token: string,
  accountId: string,
): Promise<void> {
  let verification: { status?: string } | undefined;
  try {
    verification = await cloudflareRequest<{ status?: string }>(
      token,
      `${accountPath(accountId)}/tokens/verify`,
    );
  } catch (error) {
    // Cloudflare exposes separate verification endpoints for account-owned and
    // user-owned tokens. The guided least-privilege tokens created from the
    // regular API Tokens screen are user-owned, while service principals use
    // the account endpoint.
    if (
      !(error instanceof CloudflareApiError) ||
      ![400, 401, 403].includes(error.status)
    )
      throw error;
    verification = await cloudflareRequest<{ status?: string }>(
      token,
      "/user/tokens/verify",
    );
  }
  if (verification.status !== "active")
    throw new CloudflareApiError(401, ["TOKEN_INACTIVE"]);
}

function base64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}

async function cf<T>(
  env: CoreEnv,
  path: string,
  init: RequestInit,
): Promise<T> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID)
    throw new Error("CF_API_TOKEN and CF_ACCOUNT_ID must be configured");
  return cloudflareRequest<T>(
    env.CF_API_TOKEN,
    `${accountPath(env.CF_ACCOUNT_ID)}${path}`,
    init,
  );
}

export function pluginRuntimeCredentialStatus(env: CoreEnv): {
  configured: boolean;
  accountId: string;
} {
  if (!env.CF_ACCOUNT_ID || !/^[a-f0-9]{32}$/u.test(env.CF_ACCOUNT_ID))
    throw new PluginRuntimeCredentialError("target_missing");
  return {
    configured: Boolean(env.CF_API_TOKEN),
    accountId: env.CF_ACCOUNT_ID,
  };
}

export async function configurePluginRuntimeCredential(
  env: CoreEnv,
  token: string,
): Promise<void> {
  const { accountId } = pluginRuntimeCredentialStatus(env);
  if (!env.CORE_WORKER_NAME)
    throw new PluginRuntimeCredentialError("target_missing");
  try {
    await verifyCloudflareToken(token, accountId);

    // Account-owned tokens do not need Account Settings access and may reject
    // the global account-list endpoint. User tokens remain supported, but if
    // they can list accounts they must expose only the selected account.
    try {
      const accounts = await cloudflareRequest<Array<{ id: string }>>(
        token,
        "/accounts?per_page=50",
      );
      if (accounts.length !== 1 || accounts[0]?.id !== accountId)
        throw new PluginRuntimeCredentialError("invalid");
    } catch (error) {
      if (
        !(error instanceof CloudflareApiError) ||
        (error.status !== 401 && error.status !== 403)
      )
        throw error;
    }
    const workers = await cloudflareRequest<Array<{ id: string }>>(
      token,
      `${accountPath(accountId)}/workers/scripts`,
    );
    if (!workers.some((worker) => worker.id === env.CORE_WORKER_NAME))
      throw new PluginRuntimeCredentialError("invalid");

    const isDenied = async (path: string): Promise<boolean> => {
      try {
        await cloudflareRequest<unknown>(token, path);
        return false;
      } catch (error) {
        if (
          error instanceof CloudflareApiError &&
          (error.status === 401 || error.status === 403)
        )
          return true;
        throw error;
      }
    };
    // Cloudflare currently lets an account-owned Workers Scripts Write token
    // list Queue metadata even when its sole policy is Workers Scripts Write.
    // Queue listing therefore cannot distinguish the guided least-privilege
    // token from a broader token. D1 remains an independent, non-mutating
    // negative permission probe.
    const d1Denied = await isDenied(
      `${accountPath(accountId)}/d1/database?per_page=1`,
    );
    if (!d1Denied) throw new PluginRuntimeCredentialError("too_broad");

    await cloudflareRequest<unknown>(
      token,
      `${accountPath(accountId)}/workers/scripts/${encodeURIComponent(env.CORE_WORKER_NAME)}/secrets`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "CF_API_TOKEN",
          text: token,
          type: "secret_text",
        }),
      },
    );
  } catch (error) {
    if (error instanceof PluginRuntimeCredentialError) throw error;
    if (
      error instanceof CloudflareApiError &&
      (error.status === 401 || error.status === 403)
    )
      throw new PluginRuntimeCredentialError("invalid");
    throw new PluginRuntimeCredentialError("save_failed");
  }
}

const cloudflarePermissionDenied = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  (error.status === 401 || error.status === 403);

/**
 * Uses a short-lived R2-only credential supplied for one Installer request.
 * The credential is never persisted by this function or returned to callers.
 */
export async function provisionR2Bucket(
  token: string,
  accountId: string,
  bucketName: string,
  mode: "create" | "attach",
): Promise<{ name: string; created: boolean }> {
  if (
    !/^[a-f0-9]{32}$/u.test(accountId) ||
    !/^[a-z0-9][a-z0-9-]{2,62}$/u.test(bucketName)
  )
    throw new R2ProvisioningError("invalid");
  try {
    await verifyCloudflareToken(token, accountId);

    try {
      const accounts = await cloudflareRequest<Array<{ id: string }>>(
        token,
        "/accounts?per_page=50",
      );
      if (accounts.length !== 1 || accounts[0]?.id !== accountId)
        throw new R2ProvisioningError("invalid");
    } catch (error) {
      if (!cloudflarePermissionDenied(error)) throw error;
    }

    const denied = async (path: string): Promise<boolean> => {
      try {
        await cloudflareRequest<unknown>(token, path);
        return false;
      } catch (error) {
        if (cloudflarePermissionDenied(error)) return true;
        throw error;
      }
    };
    const [workersDenied, d1Denied] = await Promise.all([
      denied(`${accountPath(accountId)}/workers/scripts`),
      denied(`${accountPath(accountId)}/d1/database?per_page=1`),
    ]);
    if (!workersDenied || !d1Denied) throw new R2ProvisioningError("too_broad");

    const path = `${accountPath(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}`;
    let exists = false;
    try {
      const bucket = await cloudflareRequest<{ name?: string }>(token, path);
      exists = bucket.name === bucketName;
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404)
        throw error;
    }
    if (mode === "attach") {
      if (!exists) throw new R2ProvisioningError("bucket_missing");
      return { name: bucketName, created: false };
    }
    if (exists) return { name: bucketName, created: false };
    const created = await cloudflareRequest<{ name?: string }>(
      token,
      `${accountPath(accountId)}/r2/buckets`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: bucketName, storageClass: "Standard" }),
      },
    );
    if (created.name !== bucketName)
      throw new R2ProvisioningError("unavailable");
    return { name: bucketName, created: true };
  } catch (error) {
    if (error instanceof R2ProvisioningError) throw error;
    if (
      error instanceof CloudflareApiError &&
      error.codes.some((code) => ["10042", "10043", "10062"].includes(code))
    )
      throw new R2ProvisioningError("not_entitled");
    if (cloudflarePermissionDenied(error))
      throw new R2ProvisioningError("invalid");
    if (error instanceof CloudflareApiError && error.status === 409)
      throw new R2ProvisioningError("bucket_conflict");
    throw new R2ProvisioningError("unavailable");
  }
}

/**
 * Provision or attach a single external resource with a credential supplied
 * for this request. The token is intentionally neither persisted nor returned.
 */
export async function provisionPluginResource(
  token: string,
  accountId: string,
  request:
    | {
        type: "r2";
        mode: "create" | "attach";
        name: string;
      }
    | {
        type: "kv";
        mode: "create" | "attach";
        name: string;
        id?: string | undefined;
        jurisdiction?: "eu" | "fedramp" | "us" | undefined;
      }
    | {
        type: "queue";
        mode: "create" | "attach";
        name: string;
        id?: string | undefined;
      },
): Promise<{
  externalId: string | null;
  externalName: string;
  created: boolean;
}> {
  if (
    !/^[a-f0-9]{32}$/u.test(accountId) ||
    token.length < 40 ||
    token.length > 2_048 ||
    !/^[A-Za-z0-9][A-Za-z0-9 _.-]{2,127}$/u.test(request.name)
  )
    throw new PluginResourceProvisioningError("invalid");
  if (request.type === "r2") {
    try {
      const result = await provisionR2Bucket(
        token,
        accountId,
        request.name,
        request.mode,
      );
      return {
        externalId: null,
        externalName: result.name,
        created: result.created,
      };
    } catch (error) {
      if (!(error instanceof R2ProvisioningError))
        throw new PluginResourceProvisioningError("unavailable");
      const mapped =
        error.code === "bucket_missing"
          ? "not_found"
          : error.code === "bucket_conflict"
            ? "conflict"
            : error.code === "not_entitled"
              ? "not_entitled"
              : error.code === "unavailable"
                ? "unavailable"
                : "invalid";
      throw new PluginResourceProvisioningError(mapped);
    }
  }
  try {
    await verifyCloudflareToken(token, accountId);
    if (request.mode === "attach") {
      if (!request.id || !/^[a-f0-9]{32}$/u.test(request.id))
        throw new PluginResourceProvisioningError("invalid");
      const path =
        request.type === "kv"
          ? `${accountPath(accountId)}/storage/kv/namespaces/${encodeURIComponent(request.id)}`
          : `${accountPath(accountId)}/queues/${encodeURIComponent(request.id)}`;
      const existing = await cloudflareRequest<{
        id?: string;
        title?: string;
        queue_id?: string;
        queue_name?: string;
      }>(token, path);
      const id = existing.id ?? existing.queue_id;
      const name = existing.title ?? existing.queue_name;
      if (id !== request.id || name !== request.name)
        throw new PluginResourceProvisioningError("not_found");
      return { externalId: id, externalName: name, created: false };
    }
    const path =
      request.type === "kv"
        ? `${accountPath(accountId)}/storage/kv/namespaces`
        : `${accountPath(accountId)}/queues`;
    const result = await cloudflareRequest<{
      id?: string;
      title?: string;
      queue_id?: string;
      queue_name?: string;
    }>(token, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        request.type === "kv"
          ? {
              title: request.name,
              ...(request.jurisdiction
                ? { jurisdiction: request.jurisdiction }
                : {}),
            }
          : { queue_name: request.name },
      ),
    });
    const id = result.id ?? result.queue_id;
    const name = result.title ?? result.queue_name;
    if (!id || !name) throw new PluginResourceProvisioningError("unavailable");
    return { externalId: id, externalName: name, created: true };
  } catch (error) {
    if (error instanceof PluginResourceProvisioningError) throw error;
    if (cloudflarePermissionDenied(error))
      throw new PluginResourceProvisioningError("invalid");
    if (error instanceof CloudflareApiError && error.status === 404)
      throw new PluginResourceProvisioningError("not_found");
    if (
      error instanceof CloudflareApiError &&
      (error.status === 400 || error.status === 409)
    )
      throw new PluginResourceProvisioningError("conflict");
    throw new PluginResourceProvisioningError("unavailable");
  }
}

export async function uploadPluginWorker(
  env: CoreEnv,
  workerName: string,
  code: string,
  manifest: {
    packageFormat?: 2 | undefined;
    compatibilityDate: string;
    compatibilityFlags: string[];
    runtimeBindings?: Array<"ai" | "r2"> | undefined;
    optionalRuntimeBindings?: Array<"ai" | "r2"> | undefined;
    resources?:
      | Array<{
          name: string;
          type: PluginRuntimeResource["type"];
          binding: string;
          required: boolean;
          configuration: Record<string, unknown>;
        }>
      | undefined;
  },
  runtimeResources: PluginRuntimeResource[] | { STORAGE?: string } = [],
  packageFiles: Record<string, string> = {},
): Promise<void> {
  const resolvedResources: PluginRuntimeResource[] = Array.isArray(
    runtimeResources,
  )
    ? runtimeResources
    : runtimeResources.STORAGE
      ? [
          {
            logicalName: "storage",
            type: "r2",
            binding: "STORAGE",
            required: Boolean(manifest.runtimeBindings?.includes("r2")),
            externalName: runtimeResources.STORAGE,
            externalId: null,
            configuration: {},
          },
        ]
      : [];
  const bindingsByName = new Map<string, Binding>();
  const addBinding = (binding: Binding): void => {
    bindingsByName.set(binding.name, binding);
  };
  addBinding({
    type: "plain_text",
    name: "DATABASE_PROVIDER",
    text: env.DATABASE_PROVIDER,
  });
  if (env.DATABASE_PROVIDER === "d1") {
    if (!env.D1_DATABASE_ID)
      throw new Error("D1_DATABASE_ID is not configured");
    addBinding({ type: "d1", name: "DB", database_id: env.D1_DATABASE_ID });
  } else {
    if (!env.HYPERDRIVE_ID) throw new Error("HYPERDRIVE_ID is not configured");
    addBinding({
      type: "hyperdrive",
      name: "HYPERDRIVE",
      id: env.HYPERDRIVE_ID,
    });
  }
  if (manifest.runtimeBindings?.includes("ai"))
    addBinding({ type: "ai", name: "AI" });
  const supportsR2 =
    manifest.runtimeBindings?.includes("r2") ||
    manifest.optionalRuntimeBindings?.includes("r2");
  const legacyStorage = resolvedResources.find(
    (resource) => resource.binding === "STORAGE" && resource.type === "r2",
  );
  if (supportsR2 && legacyStorage?.externalName) {
    addBinding({
      type: "r2_bucket",
      name: "STORAGE",
      bucket_name: legacyStorage.externalName,
    });
  }
  if (manifest.runtimeBindings?.includes("r2") && !legacyStorage?.externalName)
    throw new Error("PLUGIN_RUNTIME_R2_REQUIRED");
  const durableExports: Record<
    string,
    { type: "durable-object"; storage: "sqlite" }
  > = {};
  for (const resource of resolvedResources) {
    if (resource.type === "database") {
      if (env.DATABASE_PROVIDER === "d1")
        addBinding({
          type: "d1",
          name: resource.binding,
          database_id: env.D1_DATABASE_ID,
        });
      else
        addBinding({
          type: "hyperdrive",
          name: resource.binding,
          id: env.HYPERDRIVE_ID,
        });
    } else if (resource.type === "ai")
      addBinding({ type: "ai", name: resource.binding });
    else if (resource.type === "r2" && resource.externalName)
      addBinding({
        type: "r2_bucket",
        name: resource.binding,
        bucket_name: resource.externalName,
      });
    else if (resource.type === "kv" && resource.externalId)
      addBinding({
        type: "kv_namespace",
        name: resource.binding,
        namespace_id: resource.externalId,
      });
    else if (resource.type === "queue" && resource.externalName)
      addBinding({
        type: "queue",
        name: resource.binding,
        queue_name: resource.externalName,
      });
    else if (resource.type === "durable_object") {
      const className = resource.configuration.className;
      if (
        typeof className !== "string" ||
        !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u.test(className)
      )
        throw new Error("PLUGIN_DURABLE_OBJECT_CLASS_INVALID");
      addBinding({
        type: "durable_object_namespace",
        name: resource.binding,
        class_name: className,
      });
      durableExports[className] = {
        type: "durable-object",
        storage: "sqlite",
      };
    } else if (
      resource.required &&
      ["r2", "kv", "queue"].includes(resource.type)
    )
      throw new Error(`PLUGIN_RUNTIME_RESOURCE_REQUIRED_${resource.binding}`);
  }
  const usesAi =
    manifest.runtimeBindings?.includes("ai") ||
    resolvedResources.some((resource) => resource.type === "ai");
  const aiObservability = usesAi
    ? {
        observability: {
          enabled: true,
          head_sampling_rate: 1,
          logs: {
            enabled: true,
            invocation_logs: true,
            head_sampling_rate: 1,
            persist: true,
          },
        },
      }
    : {};
  const body = new FormData();
  const mainModule =
    manifest.packageFormat === 2 ? "backend/worker.mjs" : "worker.mjs";
  body.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: mainModule,
          compatibility_date: manifest.compatibilityDate,
          compatibility_flags: manifest.compatibilityFlags,
          ...aiObservability,
          // Runtime credentials are configured as private Worker secrets after
          // installation. Preserve them during package updates; their values
          // are never readable through the Cloudflare settings API.
          keep_bindings: ["secret_text", "secret_key"],
          bindings: [...bindingsByName.values()],
          ...(Object.keys(durableExports).length
            ? { exports: durableExports }
            : {}),
        }),
      ],
      { type: "application/json" },
    ),
  );
  body.set(
    mainModule,
    new Blob([code], { type: "application/javascript+module" }),
    mainModule,
  );
  for (const [path, encoded] of Object.entries(packageFiles)) {
    if (!path.startsWith("backend/") || path === mainModule) continue;
    const extension = path.split(".").at(-1)?.toLowerCase();
    const contentType =
      extension === "wasm"
        ? "application/wasm"
        : extension === "txt"
          ? "text/plain"
          : extension === "json"
            ? "application/json"
            : "application/javascript+module";
    body.set(
      path,
      new Blob([decodePackageFile(encoded).slice().buffer as ArrayBuffer], {
        type: contentType,
      }),
      path,
    );
  }
  await cf(env, `/workers/scripts/${encodeURIComponent(workerName)}`, {
    method: "PUT",
    body,
  });
}

const cronExpressions = (resources: PluginRuntimeResource[]): string[] =>
  [
    ...new Set(
      resources.flatMap((resource) => {
        if (resource.type !== "cron") return [];
        const schedules = resource.configuration.schedules;
        return Array.isArray(schedules)
          ? schedules.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
      }),
    ),
  ].sort();

export async function configurePluginWorkerSchedules(
  env: CoreEnv,
  workerName: string,
  resources: PluginRuntimeResource[],
): Promise<void> {
  const schedules = cronExpressions(resources).map((cron) => ({ cron }));
  const result = await cf<{ schedules?: Array<{ cron?: string }> }>(
    env,
    `/workers/scripts/${encodeURIComponent(workerName)}/schedules`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(schedules),
    },
  );
  const actual = (result.schedules ?? [])
    .flatMap((schedule) => (schedule.cron ? [schedule.cron] : []))
    .sort();
  if (
    stableStringArray(actual) !==
    stableStringArray(schedules.map(({ cron }) => cron))
  )
    throw new Error("PLUGIN_CRON_VERIFICATION_FAILED");
}

const stableStringArray = (values: string[]): string =>
  JSON.stringify([...values].sort());

export async function configurePluginQueueConsumers(
  env: CoreEnv,
  workerName: string,
  resources: PluginRuntimeResource[],
): Promise<void> {
  for (const resource of resources) {
    if (
      resource.type !== "queue" ||
      resource.configuration.consumer !== true ||
      !resource.externalId
    )
      continue;
    const consumers = await cf<
      Array<{ consumer_id?: string; script_name?: string; type?: string }>
    >(env, `/queues/${encodeURIComponent(resource.externalId)}/consumers`, {
      method: "GET",
    });
    const existing = consumers.find(
      (consumer) =>
        consumer.type === "worker" && consumer.script_name === workerName,
    );
    const rawSettings = resource.configuration.settings;
    const settings =
      rawSettings &&
      typeof rawSettings === "object" &&
      !Array.isArray(rawSettings)
        ? rawSettings
        : undefined;
    const deadLetterLogicalName = resource.configuration.deadLetterResource;
    const deadLetter =
      typeof deadLetterLogicalName === "string"
        ? resources.find(
            (candidate) =>
              candidate.logicalName === deadLetterLogicalName &&
              candidate.type === "queue",
          )?.externalName
        : undefined;
    const payload = {
      type: "worker",
      script_name: workerName,
      ...(deadLetter ? { dead_letter_queue: deadLetter } : {}),
      ...(settings ? { settings } : {}),
    };
    const path = existing?.consumer_id
      ? `/queues/${encodeURIComponent(resource.externalId)}/consumers/${encodeURIComponent(existing.consumer_id)}`
      : `/queues/${encodeURIComponent(resource.externalId)}/consumers`;
    await cf(env, path, {
      method: existing?.consumer_id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
}

export async function removePluginQueueConsumers(
  env: CoreEnv,
  workerName: string,
  resources: PluginRuntimeResource[],
): Promise<void> {
  for (const resource of resources) {
    if (resource.type !== "queue" || !resource.externalId) continue;
    const consumers = await cf<
      Array<{ consumer_id?: string; script_name?: string; type?: string }>
    >(env, `/queues/${encodeURIComponent(resource.externalId)}/consumers`, {
      method: "GET",
    });
    for (const consumer of consumers) {
      if (
        consumer.type !== "worker" ||
        consumer.script_name !== workerName ||
        !consumer.consumer_id
      )
        continue;
      await cf(
        env,
        `/queues/${encodeURIComponent(resource.externalId)}/consumers/${encodeURIComponent(consumer.consumer_id)}`,
        { method: "DELETE" },
      );
    }
  }
}

export async function attachPluginR2Binding(
  env: CoreEnv,
  workerName: string,
  bucketName: string,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/u.test(bucketName))
    throw new Error("PLUGIN_RUNTIME_R2_NAME_INVALID");
  const path = `/workers/scripts/${encodeURIComponent(workerName)}/settings`;
  const current = await cf<WorkerSettings>(env, path, { method: "GET" });
  const bindings: Binding[] = (current.bindings ?? [])
    .filter((binding) => binding.name !== "STORAGE")
    .map((binding) => ({ type: "inherit", name: binding.name }));
  bindings.push({
    type: "r2_bucket",
    name: "STORAGE",
    bucket_name: bucketName,
  });
  const body = new FormData();
  body.set(
    "settings",
    new Blob([JSON.stringify({ bindings })], { type: "application/json" }),
    "settings",
  );
  await cf(env, path, { method: "PATCH", body });
  const verified = await cf<WorkerSettings>(env, path, { method: "GET" });
  if (
    !(verified.bindings ?? []).some(
      (binding) => binding.name === "STORAGE" && binding.type === "r2_bucket",
    )
  )
    throw new Error("Plugin R2 binding verification failed");
}

export async function attachPluginResourceBinding(
  env: CoreEnv,
  workerName: string,
  resource: PluginRuntimeResource,
): Promise<void> {
  let binding: Binding;
  if (resource.type === "r2" && resource.externalName)
    binding = {
      type: "r2_bucket",
      name: resource.binding,
      bucket_name: resource.externalName,
    };
  else if (resource.type === "kv" && resource.externalId)
    binding = {
      type: "kv_namespace",
      name: resource.binding,
      namespace_id: resource.externalId,
    };
  else if (resource.type === "queue" && resource.externalName)
    binding = {
      type: "queue",
      name: resource.binding,
      queue_name: resource.externalName,
    };
  else throw new Error("PLUGIN_RUNTIME_RESOURCE_BINDING_INVALID");
  const path = `/workers/scripts/${encodeURIComponent(workerName)}/settings`;
  const current = await cf<WorkerSettings>(env, path, { method: "GET" });
  const bindings: Binding[] = (current.bindings ?? [])
    .filter((candidate) => candidate.name !== resource.binding)
    .map((candidate) => ({ type: "inherit", name: candidate.name }));
  bindings.push(binding);
  const body = new FormData();
  body.set(
    "settings",
    new Blob([JSON.stringify({ bindings })], { type: "application/json" }),
    "settings",
  );
  await cf(env, path, { method: "PATCH", body });
  const verified = await cf<WorkerSettings>(env, path, { method: "GET" });
  if (
    !(verified.bindings ?? []).some(
      (candidate) =>
        candidate.name === resource.binding && candidate.type === binding.type,
    )
  )
    throw new Error("Plugin resource binding verification failed");
}

async function uploadCoreAssets(
  env: CoreEnv,
  release: InstallerRelease,
  archive: VerifiedCoreArchive,
): Promise<string> {
  const workerName = encodeURIComponent(env.CORE_WORKER_NAME);
  const manifest = Object.fromEntries(
    release.assets.map((asset) => [
      `/${asset.path}`,
      { hash: asset.uploadHash, size: asset.size },
    ]),
  );
  const session = await cf<AssetUploadSession>(
    env,
    `/workers/scripts/${workerName}/assets-upload-session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest }),
    },
  );
  if (!session.jwt || !Array.isArray(session.buckets))
    throw new Error("CORE_UPDATE_ASSET_SESSION_INVALID");
  const byHash = new Map<string, ReleaseAsset>(
    release.assets.map((asset) => [asset.uploadHash, asset]),
  );
  let completionJwt = session.jwt;
  for (const bucket of session.buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const descriptor = byHash.get(hash);
      if (!descriptor)
        throw new Error("CORE_UPDATE_ASSET_SESSION_UNKNOWN_HASH");
      form.append(
        hash,
        new File([base64(archive.object(descriptor))], hash, {
          type: descriptor.mimeType,
        }),
        hash,
      );
    }
    const uploaded = await cloudflareRequest<{ jwt?: string }>(
      session.jwt,
      `${accountPath(env.CF_ACCOUNT_ID!)}/workers/assets/upload?base64=true`,
      { method: "POST", body: form },
    );
    if (uploaded.jwt) completionJwt = uploaded.jwt;
  }
  return completionJwt;
}

export async function deployCoreUpdate(
  env: CoreEnv,
  release: InstallerRelease,
  archive: VerifiedCoreArchive,
): Promise<void> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CORE_WORKER_NAME)
    throw new Error("CORE_UPDATE_CREDENTIAL_MISSING");
  const workerName = encodeURIComponent(env.CORE_WORKER_NAME);
  const current = await cf<WorkerSettings>(
    env,
    `/workers/scripts/${workerName}/settings`,
    { method: "GET" },
  );
  const currentBindings = current.bindings ?? [];
  const requiredBindings = new Set(["ASSETS", "DB", "WEBHOOK_QUEUE"]);
  for (const required of requiredBindings)
    if (!currentBindings.some((binding) => binding.name === required))
      throw new Error(`CORE_UPDATE_REQUIRED_BINDING_MISSING_${required}`);

  const assetJwt = await uploadCoreAssets(env, release, archive);
  const bindings: Binding[] = currentBindings
    .filter(
      (binding) => binding.name !== "ASSETS" && binding.name !== "APP_VERSION",
    )
    .map((binding) => ({ type: "inherit", name: binding.name }));
  bindings.push(
    { type: "assets", name: "ASSETS" },
    { type: "plain_text", name: "APP_VERSION", text: release.appVersion },
  );
  const body = new FormData();
  body.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: release.entrypoint,
          compatibility_date: release.compatibilityDate,
          compatibility_flags: release.compatibilityFlags,
          annotations: {
            "workers/message": `Update Nexus Edge ${release.appVersion}`,
          },
          assets: {
            jwt: assetJwt,
            config: {
              not_found_handling: "single-page-application",
              run_worker_first: ["/api/*", "/health"],
            },
          },
          bindings,
        }),
      ],
      { type: "application/json" },
    ),
    "metadata.json",
  );
  const deployableModules = release.modules.filter((descriptor) =>
    isWorkerModuleContentType(descriptor.mimeType),
  );
  if (!deployableModules.some(({ path }) => path === release.entrypoint))
    throw new Error("CORE_UPDATE_ENTRYPOINT_INVALID");
  for (const descriptor of deployableModules)
    body.set(
      descriptor.path,
      new Blob([archive.object(descriptor)], { type: descriptor.mimeType }),
      descriptor.path,
    );
  await cf(env, `/workers/scripts/${workerName}?bindings_inherit=strict`, {
    method: "PUT",
    body,
  });
}

export async function verifyCoreUpdateBindings(env: CoreEnv): Promise<void> {
  const settings = await cf<WorkerSettings>(
    env,
    `/workers/scripts/${encodeURIComponent(env.CORE_WORKER_NAME)}/settings`,
    { method: "GET" },
  );
  const names = new Set(
    (settings.bindings ?? []).map((binding) => binding.name),
  );
  for (const required of [
    "ASSETS",
    "DB",
    "WEBHOOK_QUEUE",
    "APP_VERSION",
    "BETTER_AUTH_SECRET",
    "WEBHOOK_ENCRYPTION_KEY",
  ])
    if (!names.has(required))
      throw new Error(`CORE_UPDATE_BINDING_VERIFICATION_FAILED_${required}`);
}

export async function hardenPluginWorker(
  env: CoreEnv,
  workerName: string,
): Promise<void> {
  await cf(
    env,
    `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
    { method: "DELETE" },
  );
  const state = await cf<{ enabled: boolean; previews_enabled: boolean }>(
    env,
    `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
    { method: "GET" },
  );
  if (state.enabled || state.previews_enabled)
    throw new Error("Plugin public subdomain hardening verification failed");
}

export async function pluginSecretConfigured(
  env: CoreEnv,
  workerName: string,
  secretName: string,
): Promise<boolean> {
  const settings = await cf<{ bindings: Binding[] }>(
    env,
    `/workers/scripts/${encodeURIComponent(workerName)}/settings`,
    { method: "GET" },
  );
  return (settings.bindings ?? []).some(
    (binding) =>
      binding.name === secretName &&
      (binding.type === "secret_text" || binding.type === "secret_key"),
  );
}

export async function putPluginSecret(
  env: CoreEnv,
  workerName: string,
  secretName: string,
  value: string,
): Promise<void> {
  await cf(env, `/workers/scripts/${encodeURIComponent(workerName)}/secrets`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: secretName,
      text: value,
      type: "secret_text",
    }),
  });
}

export async function deletePluginSecret(
  env: CoreEnv,
  workerName: string,
  secretName: string,
): Promise<void> {
  await cf(
    env,
    `/workers/scripts/${encodeURIComponent(workerName)}/secrets/${encodeURIComponent(secretName)}`,
    { method: "DELETE" },
  );
}

export async function getCoreBindings(env: CoreEnv): Promise<Binding[]> {
  const settings = await cf<{ bindings: Binding[] }>(
    env,
    `/workers/scripts/${encodeURIComponent(env.CORE_WORKER_NAME)}/settings`,
    { method: "GET" },
  );
  return settings.bindings ?? [];
}

export async function replaceCoreBindings(
  env: CoreEnv,
  bindings: Binding[],
): Promise<void> {
  const body = new FormData();
  body.set(
    "settings",
    new Blob([JSON.stringify({ bindings })], { type: "application/json" }),
    "settings",
  );
  await cf(
    env,
    `/workers/scripts/${encodeURIComponent(env.CORE_WORKER_NAME)}/settings`,
    {
      method: "PATCH",
      body,
    },
  );
}

export async function mergeCoreServiceBinding(
  env: CoreEnv,
  bindingName: string,
  workerName: string,
): Promise<void> {
  const bindings: Binding[] = (await getCoreBindings(env))
    .filter((binding) => binding.name !== bindingName)
    .map((binding) => ({ type: "inherit", name: binding.name }));
  bindings.push({ type: "service", name: bindingName, service: workerName });
  await replaceCoreBindings(env, bindings);
  const verified = await getCoreBindings(env);
  if (
    !verified.some(
      (binding) => binding.name === bindingName && binding.type === "service",
    )
  )
    throw new Error("Service Binding verification failed");
}

export async function removeCoreServiceBinding(
  env: CoreEnv,
  bindingName: string,
): Promise<void> {
  await replaceCoreBindings(
    env,
    (await getCoreBindings(env))
      .filter((binding) => binding.name !== bindingName)
      .map((binding) => ({ type: "inherit", name: binding.name })),
  );
}

export async function deletePluginWorker(
  env: CoreEnv,
  workerName: string,
): Promise<void> {
  try {
    await cf(env, `/workers/scripts/${encodeURIComponent(workerName)}`, {
      method: "DELETE",
    });
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || error.status !== 404)
      throw error;
  }
}
