import type { CoreEnv } from "../env.js";

type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
};
export type Binding = Record<string, unknown> & { name: string; type: string };

const base = (env: CoreEnv): string =>
  `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}`;

async function cf<T>(
  env: CoreEnv,
  path: string,
  init: RequestInit,
): Promise<T> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID)
    throw new Error("CF_API_TOKEN and CF_ACCOUNT_ID must be configured");
  const response = await fetch(`${base(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  const envelope = await response.json<CloudflareEnvelope<T>>();
  if (!response.ok || !envelope.success)
    throw new Error(
      `Cloudflare API failed (${response.status}): ${envelope.errors?.map((error) => error.code).join(",") || "unknown"}`,
    );
  return envelope.result;
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
