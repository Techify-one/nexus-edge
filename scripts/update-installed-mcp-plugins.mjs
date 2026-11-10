// Owner-authorized release installation. Credentials stay in process memory.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";

const credentialsFile = process.argv[2];
const mode = process.argv[3] ?? "inspect";
if (!credentialsFile || !["inspect", "update", "verify"].includes(mode))
  throw new Error(
    "Usage: node scripts/update-installed-mcp-plugins.mjs /path/to/ignored/credentials [inspect|update|verify]",
  );
const credentials = parseEnv(readFileSync(credentialsFile, "utf8"));
const base = credentials.PRODUCTION_BASE_URL;
if (
  !base ||
  new URL(base).protocol !== "https:" ||
  !credentials.PRODUCTION_ADMIN_EMAIL ||
  !credentials.PRODUCTION_ADMIN_PASSWORD
)
  throw new Error(
    "Populate PRODUCTION_BASE_URL and administrator credentials in the ignored local file.",
  );
const cookies = new Map();
async function call(
  path,
  { method = "GET", json, body, binary = false, headers: supplied = {} } = {},
) {
  const headers = new Headers(supplied);
  headers.set("Origin", base);
  headers.set(
    "Accept",
    binary ? "application/octet-stream" : "application/json",
  );
  if (json !== undefined) headers.set("Content-Type", "application/json");
  if (cookies.size)
    headers.set(
      "Cookie",
      [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    );
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body,
    redirect: "manual",
    signal: AbortSignal.timeout(90_000),
  });
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `${method} ${path}: HTTP ${response.status} ${error.error?.code ?? "REQUEST_FAILED"}`,
    );
  }
  if (binary)
    return {
      bytes: await response.arrayBuffer(),
      releaseId: response.headers.get("X-Plugin-Release-Id"),
    };
  return response.status === 204 ? null : response.json();
}
await call("/api/auth/sign-in/email", {
  method: "POST",
  json: {
    email: credentials.PRODUCTION_ADMIN_EMAIL,
    password: credentials.PRODUCTION_ADMIN_PASSWORD,
  },
});
const health = await call("/health");
if (health.provider !== "d1")
  throw new Error(
    "Provider differs from the expected hub. Stopped without modifying plugins.",
  );
const expected = {
  asaas: "1.2.1",
  crm: "2.0.5",
  financeiro: "1.1.4",
  meeting_recorder: "2.1.3",
  meta_ads: "2.0.4",
  soletrando: "2.0.4",
  platform_probe: "1.0.3",
};
const installed = (await call("/api/v1/plugins")).items.filter(
  (plugin) => plugin.status === "installed",
);
if (mode === "inspect") {
  console.log(
    JSON.stringify({
      health,
      installed: installed.map(({ id, installedVersion }) => ({
        id,
        version: installedVersion,
        target: expected[id] ?? null,
      })),
    }),
  );
} else if (mode === "update") {
  if (health.version !== "1.1.0-beta.16")
    throw new Error("Deploy and verify the MCP Core before updating plugins.");
  const sources = (await call("/api/v1/plugin-marketplaces")).items;
  const source = sources.find(
    (item) =>
      item.owner === "Techify-one" && item.repository === "nexus-edge-plugins",
  );
  if (!source || source.trustState !== "trusted")
    throw new Error("Expected trusted marketplace is unavailable.");
  await call(
    `/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}/sync`,
    { method: "POST" },
  );
  const catalog = (await call("/api/v1/plugin-catalog")).items;
  for (const plugin of installed) {
    const target = expected[plugin.id];
    if (!target || target === plugin.installedVersion) continue;
    const release = catalog.find(
      (item) =>
        item.pluginId === plugin.id &&
        item.version === target &&
        item.marketplaceId === source.id &&
        item.compatible,
    );
    if (!release)
      throw new Error(
        `Missing compatible signed release for ${plugin.id} ${target}`,
      );
    const archive = await call(
      `/api/v1/plugin-catalog/${encodeURIComponent(release.id)}/package`,
      { method: "POST", binary: true },
    );
    if (!archive.releaseId)
      throw new Error("Missing validated release identity.");
    const form = () => {
      const data = new FormData();
      data.set(
        "package",
        new File([archive.bytes], `${plugin.id}.plugin.zip`, {
          type: "application/zip",
        }),
      );
      data.set("sourceReleaseId", archive.releaseId);
      return data;
    };
    let operation = await call("/api/v1/plugin-operations", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: form(),
    });
    for (
      let step = 0;
      !["installed", "failed"].includes(operation.state) && step < 30;
      step++
    ) {
      console.log(
        JSON.stringify({
          plugin: plugin.id,
          operationId: operation.operationId,
          stage: operation.state,
        }),
      );
      if (operation.state === "provisioning")
        throw new Error(
          `${plugin.id}: unexpected resource provisioning required; stopped without replacing resources.`,
        );
      if (operation.state === "registering")
        await new Promise((resolve) => setTimeout(resolve, 3000));
      operation = await call(
        `/api/v1/plugin-operations/${operation.operationId}/advance`,
        { method: "POST", body: form() },
      );
    }
    if (operation.state !== "installed")
      throw new Error(
        `${plugin.id}: Installer did not complete; operation ${operation.operationId}, state ${operation.state}`,
      );
    const current = (await call("/api/v1/plugins")).items.find(
      (item) => item.id === plugin.id,
    );
    if (current?.installedVersion !== target || current?.status !== "installed")
      throw new Error(`${plugin.id}: installed version verification failed.`);
    console.log(
      JSON.stringify({ plugin: plugin.id, version: target, installed: true }),
    );
  }
} else {
  if (health.version !== "1.1.0-beta.16")
    throw new Error("Unexpected Core version.");
  const settings = [];
  for (const plugin of installed) {
    if (expected[plugin.id] && plugin.installedVersion !== expected[plugin.id])
      throw new Error(`${plugin.id}: expected version is not installed.`);
    const config = await call(`/api/v1/plugins/${plugin.id}/mcp`);
    if (!config.actions.length)
      throw new Error(`${plugin.id}: no MCP action definitions available.`);
    settings.push({
      plugin: plugin.id,
      version: plugin.installedVersion,
      enabled: config.enabled,
      actions: config.actions.length,
      allowed: config.allowedActions.length,
    });
  }
  const initialized = await call("/mcp", {
    method: "POST",
    json: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "nexus-release-verification", version: "1.0.0" },
      },
    },
  });
  if (initialized.result?.protocolVersion !== "2025-11-25")
    throw new Error("MCP initialization failed.");
  console.log(
    JSON.stringify({ health, plugins: settings, mcpInitialized: true }),
  );
}
