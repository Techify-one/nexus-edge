import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const token = required("CLOUDFLARE_API_TOKEN");
const accountId = required("CLOUDFLARE_ACCOUNT_ID");
const d1Id = required("D1_DATABASE_ID");
const installationId = required("APP_INSTALLATION_ID");
const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
const encryptionKey = process.env.WEBHOOK_ENCRYPTION_KEY;
const installerToken = process.env.CF_API_TOKEN;
const installerAccountId = process.env.CF_ACCOUNT_ID;
const workerName = process.env.CORE_WORKER_NAME ?? "nexus-edge-core";
const publicUrl = required("APP_PUBLIC_URL");
const queueName = process.env.WEBHOOK_QUEUE_NAME ?? "nexus-edge-webhooks";
const dlqName = process.env.WEBHOOK_DLQ_NAME ?? "nexus-edge-webhooks-dlq";
const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const assetsRoot = resolve("frontend/dist/client");
const modulesRoot = resolve("frontend/dist/nexus_edge_core");

if (!existsSync(join(assetsRoot, "index.html")))
  throw new Error("Run pnpm build:frontend before a direct deployment.");
if (!existsSync(join(modulesRoot, "index.js")))
  throw new Error("Core bundle not found.");

const mime = (path) => {
  const extension = extname(path).toLowerCase();
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".txt": "text/plain; charset=utf-8",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extension] ?? "application/octet-stream"
  );
};

const files = (root, predicate) => {
  const output = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && predicate(absolute)) output.push(absolute);
    }
  };
  visit(root);
  return output.sort();
};

async function cloudflare(path, init = {}, authorization = token) {
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${authorization}`,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const details = (body.errors ?? [])
      .map((error) => `${error.code ?? "API"}: ${error.message}`)
      .join("; ");
    throw new Error(
      `Cloudflare ${init.method ?? "GET"} ${path}: ${details || response.status}`,
    );
  }
  return body.result ?? body;
}

async function currentBindings() {
  const response = await fetch(
    `${apiRoot}/workers/scripts/${workerName}/settings`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status === 404) return [];
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const details = (body.errors ?? [])
      .map((error) => `${error.code ?? "API"}: ${error.message}`)
      .join("; ");
    throw new Error(
      `Unable to read current Worker bindings: ${details || response.status}`,
    );
  }
  return body.result?.bindings ?? [];
}

const previousBindings = await currentBindings();
const secretBinding = (name, value) => {
  if (value) return { type: "secret_text", name, text: value };
  if (
    previousBindings.some(
      (binding) => binding.name === name && binding.type === "secret_text",
    )
  )
    return { type: "inherit", name };
  throw new Error(`${name} is required for the initial deployment.`);
};
const pluginBindings = previousBindings
  .filter(
    (binding) =>
      binding.type === "service" && binding.name.startsWith("PLUGIN_"),
  )
  .map((binding) => ({ type: "inherit", name: binding.name }));

const assetFiles = files(
  assetsRoot,
  (path) => !path.endsWith(".map") && !path.endsWith(".assetsignore"),
);
const manifest = {};
const assetByHash = new Map();
for (const path of assetFiles) {
  const content = readFileSync(path);
  const extension = extname(path).slice(1);
  const hash = createHash("sha256")
    .update(content.toString("base64") + extension)
    .digest("hex")
    .slice(0, 32);
  const assetPath = `/${relative(assetsRoot, path).replaceAll("\\", "/")}`;
  manifest[assetPath] = { hash, size: statSync(path).size };
  assetByHash.set(hash, path);
}

const session = await cloudflare(
  `/workers/scripts/${workerName}/assets-upload-session`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifest }),
  },
);
if (!session.jwt || !Array.isArray(session.buckets))
  throw new Error("The asset session did not return JWT/buckets.");

let completionJwt = session.jwt;
for (const [index, bucket] of session.buckets.entries()) {
  const form = new FormData();
  for (const hash of bucket) {
    const path = assetByHash.get(hash);
    if (!path) throw new Error(`Requested asset not found: ${hash}`);
    form.append(
      hash,
      new File([readFileSync(path).toString("base64")], hash, {
        type: mime(path),
      }),
      hash,
    );
  }
  const uploaded = await cloudflare(
    "/workers/assets/upload?base64=true",
    { method: "POST", body: form },
    session.jwt,
  );
  if (uploaded.jwt) completionJwt = uploaded.jwt;
  process.stdout.write(
    `Assets: batch ${index + 1}/${session.buckets.length} completed.\n`,
  );
}

const metadata = {
  main_module: "index.js",
  compatibility_date: "2026-08-21",
  compatibility_flags: ["nodejs_compat"],
  annotations: { "workers/message": "Deploy Nexus Edge" },
  assets: {
    jwt: completionJwt,
    config: {
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/health"],
    },
  },
  bindings: [
    { type: "assets", name: "ASSETS" },
    { type: "d1", name: "DB", database_id: d1Id },
    { type: "queue", name: "WEBHOOK_QUEUE", queue_name: queueName },
    { type: "plain_text", name: "APP_VERSION", text: "1.0.0" },
    {
      type: "plain_text",
      name: "APP_INSTALLATION_ID",
      text: installationId,
    },
    { type: "plain_text", name: "DATABASE_PROVIDER", text: "d1" },
    { type: "plain_text", name: "BETTER_AUTH_URL", text: publicUrl },
    { type: "plain_text", name: "TRUSTED_ORIGINS", text: publicUrl },
    { type: "plain_text", name: "CORE_WORKER_NAME", text: workerName },
    { type: "plain_text", name: "D1_DATABASE_ID", text: d1Id },
    { type: "plain_text", name: "WEBHOOK_ALLOWED_DOMAINS", text: "" },
    { type: "plain_text", name: "API_RATE_LIMIT_MAX", text: "120" },
    {
      type: "plain_text",
      name: "API_RATE_LIMIT_WINDOW_SECONDS",
      text: "60",
    },
    {
      type: "plain_text",
      name: "PLUGIN_COMPATIBILITY_FLAGS",
      text: "nodejs_compat",
    },
    secretBinding("BETTER_AUTH_SECRET", betterAuthSecret),
    secretBinding("WEBHOOK_ENCRYPTION_KEY", encryptionKey),
    secretBinding("CF_API_TOKEN", installerToken),
    secretBinding("CF_ACCOUNT_ID", installerAccountId),
    ...pluginBindings,
  ],
};

const workerForm = new FormData();
workerForm.append(
  "metadata",
  new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  "metadata.json",
);
for (const path of files(modulesRoot, (item) => item.endsWith(".js"))) {
  const moduleName = relative(modulesRoot, path).replaceAll("\\", "/");
  workerForm.append(
    moduleName,
    new Blob([readFileSync(path)], { type: "application/javascript+module" }),
    moduleName,
  );
}

const worker = await cloudflare(`/workers/scripts/${workerName}`, {
  method: "PUT",
  body: workerForm,
});

await cloudflare(`/workers/scripts/${workerName}/subdomain`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ enabled: true, previews_enabled: false }),
});
await cloudflare(`/workers/scripts/${workerName}/schedules`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify([{ cron: "* * * * *" }]),
});

const queueList = await cloudflare("/queues?per_page=100");
const queue = queueList.find((item) => item.queue_name === queueName);
if (!queue) throw new Error(`Queue ${queueName} not found.`);
const existingConsumer = (queue.consumers ?? []).find(
  (item) => item.script === workerName || item.service === workerName,
);
const consumerBody = {
  type: "worker",
  dead_letter_queue: dlqName,
  script_name: workerName,
  settings: {
    batch_size: 5,
    max_retries: 6,
    max_wait_time_ms: 5_000,
  },
};
if (existingConsumer) {
  await cloudflare(
    `/queues/${queue.queue_id}/consumers/${existingConsumer.consumer_id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(consumerBody),
    },
  );
} else {
  await cloudflare(`/queues/${queue.queue_id}/consumers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(consumerBody),
  });
}

process.stdout.write(
  JSON.stringify({
    success: true,
    worker: worker.id ?? workerName,
    url: publicUrl,
    assets: assetFiles.length,
  }) + "\n",
);
