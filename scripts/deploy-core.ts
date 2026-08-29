import { execFileSync } from "node:child_process";
import {
  bindingsForServiceRestore,
  type WorkerBinding,
} from "./cloudflare-bindings.js";

type Envelope<T> = {
  success: boolean;
  result: T;
  errors?: { message: string }[];
};

const token = process.env.CF_API_TOKEN;
const accountId = process.env.CF_ACCOUNT_ID;
const workerName = process.env.CORE_WORKER_NAME ?? "nexus-edge-core";
const config =
  process.env.CORE_WRANGLER_CONFIG ?? "workers/core/wrangler.jsonc";
const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/settings`;

async function settings(): Promise<WorkerBinding[]> {
  if (!token || !accountId) return [];
  const response = await fetch(api, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return [];
  const body = (await response.json()) as Envelope<{
    bindings?: WorkerBinding[];
  }>;
  if (!response.ok || !body.success)
    throw new Error(
      `Unable to read current bindings: ${body.errors?.map((error) => error.message).join(", ") ?? response.status}`,
    );
  return body.result.bindings ?? [];
}

async function replaceBindings(bindings: WorkerBinding[]): Promise<void> {
  if (!token || !accountId)
    throw new Error(
      "CF_API_TOKEN and CF_ACCOUNT_ID are required to preserve dynamic bindings.",
    );
  const form = new FormData();
  form.set(
    "settings",
    new Blob([JSON.stringify({ bindings })], { type: "application/json" }),
    "settings",
  );
  const response = await fetch(api, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const body = (await response.json()) as Envelope<unknown>;
  if (!response.ok || !body.success)
    throw new Error(
      `Unable to restore bindings: ${body.errors?.map((error) => error.message).join(", ") ?? response.status}`,
    );
}

const pluginBindings = (await settings()).filter(
  (binding) => binding.type === "service" && binding.name.startsWith("PLUGIN_"),
);
for (const binding of pluginBindings)
  if (typeof binding.service !== "string")
    throw new Error(
      `Dynamic binding ${binding.name} has no writable service target.`,
    );
execFileSync("pnpm", ["build:frontend"], { stdio: "inherit" });
execFileSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    config,
    "--assets",
    "frontend/dist/client",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? token,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? accountId,
    },
  },
);
if (pluginBindings.length) {
  const current = await settings();
  const merged = bindingsForServiceRestore(current, pluginBindings);
  await replaceBindings(merged);
  const verified = await settings();
  for (const plugin of pluginBindings)
    if (
      !verified.some(
        (binding) => binding.name === plugin.name && binding.type === "service",
      )
    )
      throw new Error(`Binding ${plugin.name} was not preserved.`);
}
process.stdout.write(
  `${workerName} deployment completed; ${pluginBindings.length} dynamic binding(s) preserved.\n`,
);
