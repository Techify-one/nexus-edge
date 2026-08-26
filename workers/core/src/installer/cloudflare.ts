import type { CoreEnv } from "../env.js";

type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
};
export type Binding = Record<string, unknown> & { name: string; type: string };

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
    const verification = await cloudflareRequest<{ status?: string }>(
      token,
      `${accountPath(accountId)}/tokens/verify`,
    );
    if (verification.status !== "active")
      throw new PluginRuntimeCredentialError("invalid");

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
    const [d1Denied, queuesDenied] = await Promise.all([
      isDenied(`${accountPath(accountId)}/d1/database?per_page=1`),
      isDenied(`${accountPath(accountId)}/queues?per_page=1`),
    ]);
    if (!d1Denied || !queuesDenied)
      throw new PluginRuntimeCredentialError("too_broad");

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

export async function uploadPluginWorker(
  env: CoreEnv,
  workerName: string,
  code: string,
  manifest: {
    compatibilityDate: string;
    compatibilityFlags: string[];
    runtimeBindings?: Array<"ai"> | undefined;
  },
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
  await cf(env, `/workers/scripts/${encodeURIComponent(workerName)}`, {
    method: "DELETE",
  });
}
