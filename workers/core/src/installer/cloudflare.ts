import type { CoreEnv } from "../env.js";
import {
  isWorkerModuleContentType,
  type InstallerRelease,
  type ReleaseAsset,
} from "@app/installer-release-schema";
import type { VerifiedCoreArchive } from "../updates/release.js";

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

export async function uploadPluginWorker(
  env: CoreEnv,
  workerName: string,
  code: string,
  manifest: {
    compatibilityDate: string;
    compatibilityFlags: string[];
    runtimeBindings?: Array<"ai" | "r2"> | undefined;
    optionalRuntimeBindings?: Array<"ai" | "r2"> | undefined;
  },
  runtimeResources: { STORAGE?: string } = {},
): Promise<void> {
  const bindings: Binding[] = [
    {
      type: "plain_text",
      name: "DATABASE_PROVIDER",
      text: env.DATABASE_PROVIDER,
    },
  ];
  if (env.DATABASE_PROVIDER === "d1") {
    if (!env.D1_DATABASE_ID)
      throw new Error("D1_DATABASE_ID is not configured");
    bindings.push({ type: "d1", name: "DB", database_id: env.D1_DATABASE_ID });
  } else {
    if (!env.HYPERDRIVE_ID) throw new Error("HYPERDRIVE_ID is not configured");
    bindings.push({
      type: "hyperdrive",
      name: "HYPERDRIVE",
      id: env.HYPERDRIVE_ID,
    });
  }
  if (manifest.runtimeBindings?.includes("ai"))
    bindings.push({ type: "ai", name: "AI" });
  const supportsR2 =
    manifest.runtimeBindings?.includes("r2") ||
    manifest.optionalRuntimeBindings?.includes("r2");
  if (supportsR2 && runtimeResources.STORAGE) {
    const bucketName = runtimeResources.STORAGE;
    bindings.push({
      type: "r2_bucket",
      name: "STORAGE",
      bucket_name: bucketName,
    });
  }
  if (manifest.runtimeBindings?.includes("r2") && !runtimeResources.STORAGE)
    throw new Error("PLUGIN_RUNTIME_R2_REQUIRED");
  const aiObservability = manifest.runtimeBindings?.includes("ai")
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
  body.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.mjs",
          compatibility_date: manifest.compatibilityDate,
          compatibility_flags: manifest.compatibilityFlags,
          ...aiObservability,
          // Runtime credentials are configured as private Worker secrets after
          // installation. Preserve them during package updates; their values
          // are never readable through the Cloudflare settings API.
          keep_bindings: ["secret_text", "secret_key"],
          bindings,
        }),
      ],
      { type: "application/json" },
    ),
  );
  body.set(
    "worker.mjs",
    new Blob([code], { type: "application/javascript+module" }),
    "worker.mjs",
  );
  await cf(env, `/workers/scripts/${encodeURIComponent(workerName)}`, {
    method: "PUT",
    body,
  });
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
  const bindings = (await getCoreBindings(env)).filter(
    (binding) => binding.name !== bindingName,
  );
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
    (await getCoreBindings(env)).filter(
      (binding) => binding.name !== bindingName,
    ),
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
